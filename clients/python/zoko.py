"""Independent Python 3.11+ HTTP client; standard library only, no ZoKo SDK imports.

Forking after client requests have started is unsupported: inherited DNS permit
state can include workers that do not exist in the child. Start children first,
or use a fresh interpreter via the spawn process start method.
"""
import hashlib
import http.client
import json
import math
import os
import queue
import re
import socket
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit


_DNS_MAX_INFLIGHT = 8
_DNS_SLOTS = threading.BoundedSemaphore(_DNS_MAX_INFLIGHT)


def canonical(value):
    # JSON wire number spellings differ between languages; hashes come from the server
    # and are checked again through its frozen input on dispatch. Journal integrity is local.
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def nanos(value):
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9][0-9]{0,29})", value):
        raise ValueError("Invalid integer nanoXEC")
    return int(value)


def record(path, value):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    except Exception:
        # A partial journal is a blocker, never permission to buy again.
        raise


def same_keys(value, keys):
    return isinstance(value, dict) and set(value) == set(keys)


def same_json(left, right):
    """Compare JSON values as the JavaScript server sees their numbers."""
    if left is None or right is None or isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        try:
            a, b = float(left), float(right)
        except (OverflowError, ValueError):
            return False
        return math.isfinite(a) and math.isfinite(b) and a == b
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return set(left) == set(right) and all(same_json(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(same_json(a, b) for a, b in zip(left, right))
    return left == right


def probability(value):
    return type(value) in (float, int) and math.isfinite(value) and 0 <= value <= 1


def validate_typed_output(result, data, model, usage_required):
    if not same_keys(result, ("model", "answers", "usage")) or result["model"] != model or not same_keys(result["answers"], data["questions"]):
        raise ValueError("Model or answer schema mismatch")
    for key, question in data["questions"].items():
        answer = result["answers"][key]
        kind = question["type"]
        if not isinstance(answer, dict) or answer.get("type") != kind:
            raise ValueError("Answer type mismatch")
        if kind == "noul":
            if not same_keys(answer, ("type", "noul")) or not probability(answer["noul"]):
                raise ValueError("Invalid Noul")
            continue
        fields = ("type", "choice", "probabilities", "confidence") if kind == "choice" else ("type", "score", "legend", "probabilities", "confidence")
        keys = list(question["criteria"]) if kind == "choice" else [str(i) for i in range(len(question["criteria"]))]
        if not same_keys(answer, fields) or not same_keys(answer["probabilities"], keys) or not probability(answer["confidence"]):
            raise ValueError("Invalid answer schema")
        values = list(answer["probabilities"].values())
        if not all(probability(v) for v in values) or abs(sum(values) - 1) > 0.0001:
            raise ValueError("Invalid probabilities")
        if kind == "choice":
            if answer["choice"] not in keys or answer["probabilities"][answer["choice"]] + 2.220446049250313e-16 < max(values):
                raise ValueError("Invalid Choice")
        else:
            score = answer["score"]
            expected = sum(int(k) * answer["probabilities"][k] for k in keys)
            if not same_keys(answer["legend"], keys) or any(not same_json(answer["legend"][k], question["criteria"][int(k)]) for k in keys) or type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= len(keys) - 1 or abs(score - expected) > 0.0001 * max(1, len(keys) - 1):
                raise ValueError("Invalid Score")
    usage = result["usage"]
    if usage is None:
        if usage_required:
            raise ValueError("Required backend usage missing")
    elif not same_keys(usage, ("input_tokens", "output_tokens")) or any(not (v is None and not usage_required or type(v) is int and 0 <= v <= 9007199254740991) for v in usage.values()) or all(v is None for v in usage.values()):
        raise ValueError("Invalid backend usage")


class HttpError(Exception):
    def __init__(self, status, code):
        super().__init__(f"ZoKo HTTP {status}: {code}")
        self.status, self.code = status, code


class ZokoHttpClient:
    def __init__(self, origin, key, timeout=70):
        url = urlsplit(origin)
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/") or not (url.scheme == "https" or url.scheme == "http" and url.hostname in ("127.0.0.1", "::1")):
            raise ValueError("Use HTTPS marketplace origin or numeric loopback")
        if not url.hostname or not re.fullmatch(r"[\x21-\x7e]{1,512}", key) or not 0 < timeout <= 300:
            raise ValueError("Invalid HTTP configuration")
        self.origin, self.url, self.key, self.timeout = f"{url.scheme}://{url.netloc}", url, key, timeout

    def request(self, method, path, body=None, idempotency_key=None, public=False):
        if not re.fullmatch(r"/(?:v1/|\.well-known/)[A-Za-z0-9_./-]+", path):
            raise ValueError("Invalid API path")
        connection_type = http.client.HTTPSConnection if self.url.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(self.url.hostname, self.url.port, timeout=self.timeout)
        deadline = time.monotonic() + self.timeout
        expired = threading.Event()
        transport = {"socket": None}
        transport_lock = threading.Lock()

        def interrupt(sock):
            if sock is not None:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        def publish(sock):
            with transport_lock:
                transport["socket"] = sock
                past_deadline = expired.is_set()
            if past_deadline:
                interrupt(sock)

        def expire():
            expired.set()
            # HTTPResponse may own the socket after HTTPConnection has cleared it.
            with transport_lock:
                sock = transport["socket"]
            interrupt(sock)

        def remaining():
            seconds = deadline - time.monotonic()
            if expired.is_set() or seconds <= 0:
                raise TimeoutError("ZoKo request deadline exceeded; preserve original identity")
            return seconds

        def connect_socket(address, _timeout, source_address=None):
            # getaddrinfo has no timeout parameter. Resolve on a daemon thread so
            # a late DNS answer cannot hold this request or dispatch it later.
            remaining()
            dns_slots = _DNS_SLOTS
            answers = queue.Queue(maxsize=1)

            def resolve():
                try:
                    try:
                        answers.put_nowait(socket.getaddrinfo(address[0], address[1], type=socket.SOCK_STREAM))
                    except Exception as error:
                        answers.put_nowait(error)
                finally:
                    dns_slots.release()

            worker = threading.Thread(target=resolve, name="zoko-dns-resolver", daemon=True)
            remaining()
            if not dns_slots.acquire(blocking=False):
                raise TimeoutError(f"ZoKo DNS resolver capacity ({_DNS_MAX_INFLIGHT}) exceeded; preserve original identity")
            # Thread.start() can raise after native launch. Only the worker may
            # release its slot; uncertain startup deliberately remains reserved.
            worker.start()
            try:
                addresses = answers.get(timeout=remaining())
            except queue.Empty as error:
                raise TimeoutError("ZoKo request deadline exceeded; preserve original identity") from error
            if isinstance(addresses, Exception):
                raise addresses
            last_error = None
            for family, kind, protocol, _name, endpoint in addresses:
                sock = None
                try:
                    remaining()
                    sock = socket.socket(family, kind, protocol)
                    sock.settimeout(remaining())
                    if source_address:
                        sock.bind(source_address)
                    sock.connect(endpoint)
                    publish(sock)
                    remaining()
                    return sock
                except OSError as error:
                    last_error = error
                    if sock is not None:
                        with transport_lock:
                            if transport["socket"] is sock:
                                transport["socket"] = None
                        sock.close()
                    if expired.is_set() or time.monotonic() >= deadline:
                        raise TimeoutError("ZoKo request deadline exceeded; preserve original identity") from error
            raise last_error or OSError("No resolved marketplace address")

        connection._create_connection = connect_socket
        headers = {"Accept": "application/json"}
        if not public:
            headers["Authorization"] = f"Bearer {self.key}"
        if body is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        watchdog = threading.Timer(self.timeout, expire)
        watchdog.daemon = True
        watchdog.start()
        response = None
        try:
            if self.url.scheme == "https":
                # Build the verified TLS socket without an implicit handshake.
                # Publish it before handshaking so expiry can interrupt it.
                http.client.HTTPConnection.connect(connection)
                connection.sock.settimeout(remaining())
                tls = connection._context.wrap_socket(connection.sock,
                    server_hostname=connection.host, do_handshake_on_connect=False)
                connection.sock = tls
                publish(tls)
                tls.settimeout(remaining())
                tls.do_handshake()
            else:
                connection.connect()
            connection.sock.settimeout(remaining())
            connection.request(method, path, body=canonical(body).encode() if body is not None else None, headers=headers)
            connection.sock.settimeout(remaining())
            response = connection.getresponse()
            remaining()
            if response.getheader("Content-Type", "").split(";")[0].strip() != "application/json":
                raise ValueError("Invalid response content type")
            chunks, size = [], 0
            while True:
                seconds = remaining()
                with transport_lock:
                    sock = transport["socket"]
                if sock is not None:
                    sock.settimeout(seconds)
                chunk = response.read1(65536)
                remaining()
                if not chunk:
                    if response.length not in (None, 0):
                        raise ValueError("Truncated response body")
                    break
                size += len(chunk)
                if size > 1048576:
                    raise ValueError("Response byte limit exceeded")
                chunks.append(chunk)
                if response.isclosed():
                    if response.length not in (None, 0):
                        raise ValueError("Truncated response body")
                    break
            remaining()
            data = json.loads(b"".join(chunks).decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Non-finite JSON")))
            if not 200 <= response.status < 300:
                raise HttpError(response.status, data.get("error", {}).get("code", "request_failed"))
            return data
        except Exception as error:
            if expired.is_set() or time.monotonic() >= deadline:
                raise TimeoutError("ZoKo request deadline exceeded; preserve original identity") from error
            raise
        finally:
            watchdog.cancel()
            try:
                if response is not None:
                    response.close()
            finally:
                connection.close()

    def discover(self):
        return self.request("GET", "/.well-known/zoko.json", public=True)

    def capabilities(self):
        return self.request("GET", "/v1/capabilities", public=True)

    def catalog(self):
        return self.request("GET", "/v1/catalog", public=True)

    def _validate_quote(self, quote, policy):
        if nanos(quote["priceNanos"]) > nanos(policy["maxPriceNanos"]) or quote["currency"] != "nanoXEC":
            raise ValueError("Quote exceeds spending bound")
        if policy.get("model") and quote["model"] != policy["model"] or policy.get("allowedSellers") is not None and quote["sellerId"] not in policy["allowedSellers"] or policy.get("usageRequirement") and (quote.get("inferenceContract") or {}).get("usageRequirement") != policy["usageRequirement"]:
            raise ValueError("Quote violates selected offer")
        if not all(quote.get(k) for k in ("id", "model", "sellerId", "requestHash", "schemaHash")):
            raise ValueError("Incomplete quote")

    def prepare(self, path, data, policy):
        policy = json.loads(canonical(policy))
        nanos(policy["maxPriceNanos"])
        snapshot = json.loads(canonical(data))
        if len(canonical(snapshot).encode()) > 32768:
            raise ValueError("Input byte limit exceeded")
        account = self.request("GET", "/v1/me")
        quote = self.request("POST", "/v1/quotes", {**snapshot, "policy": policy})
        self._validate_quote(quote, policy)
        journal = {"version": 1, "origin": self.origin, "accountId": account["account"]["id"], "idempotencyKey": str(uuid.uuid4()), "input": snapshot, "quote": quote, "policy": policy}
        record(path, journal)
        return journal

    def _journal(self, path):
        journal = json.loads(Path(path).read_text(encoding="utf-8"))
        if journal["version"] != 1 or journal["origin"] != self.origin or self.request("GET", "/v1/me")["account"]["id"] != journal["accountId"]:
            raise ValueError("Journal marketplace/account mismatch")
        self._validate_quote(journal["quote"], journal["policy"])
        return journal

    def _validate_receipt(self, receipt, journal):
        if not receipt.get("id") or receipt.get("status") not in ("running", "succeeded", "failed", "indeterminate"):
            raise ValueError("Invalid receipt")
        if receipt["status"] == "succeeded":
            quote = journal["quote"]
            if any(receipt.get(k) != quote[k] for k in ("sellerId", "priceNanos", "requestHash", "schemaHash")):
                raise ValueError("Receipt quote mismatch")
            contract = quote.get("inferenceContract") or {}
            validate_typed_output(receipt["result"], journal["input"], quote["model"], contract.get("usageRequirement") != "backend_reported_optional" and quote.get("deliveryMode") != "agent")

    def execute(self, path):
        journal = self._journal(path)
        identity = {"journalHash": hashlib.sha256(canonical(journal).encode()).hexdigest(), "idempotencyKey": journal["idempotencyKey"]}
        try:
            record(str(path) + ".attempt.json", identity)
        except FileExistsError:
            if json.loads(Path(str(path) + ".attempt.json").read_text()) != identity:
                raise ValueError("Attempt identity conflict")
        receipt = self.request("POST", "/v1/decisions", {"quoteId": journal["quote"]["id"], **journal["input"]}, journal["idempotencyKey"])
        self._validate_receipt(receipt, journal)
        self._save_receipt(path, receipt)
        return receipt

    def recover(self, path):
        return self.execute(path)

    def _save_receipt(self, path, receipt):
        def save(file, value):
            try:
                record(file, value)
            except FileExistsError:
                if json.loads(Path(file).read_text(encoding="utf-8")) != value:
                    raise ValueError("Receipt identity conflict")
        save(str(path) + ".decision.json", {"id": receipt["id"]})
        if receipt["status"] != "running":
            save(str(path) + ".receipt.json", receipt)

    def poll(self, path, decision_id, max_wait=60):
        if not re.fullmatch(r"[0-9a-f-]{36}", decision_id) or not 0 <= max_wait <= 300:
            raise ValueError("Invalid polling bounds")
        journal = self._journal(path)
        if json.loads(Path(str(path) + ".decision.json").read_text())["id"] != decision_id:
            raise ValueError("Polling purchase identity mismatch")
        deadline = time.monotonic() + max_wait
        while True:
            receipt = self.request("GET", f"/v1/decisions/{decision_id}")
            self._validate_receipt(receipt, journal)
            self._save_receipt(path, receipt)
            if receipt["status"] != "running" or time.monotonic() >= deadline:
                return receipt
            time.sleep(min(1, max(0, deadline - time.monotonic())))
