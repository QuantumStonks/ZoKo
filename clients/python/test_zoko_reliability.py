"""Synthetic loopback checks for the isolated Python-client review copy."""
import copy
import http.client
import json
import socket
import ssl
import sys
import threading
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_address
from pathlib import Path
from unittest.mock import patch

import zoko
from zoko import ZokoHttpClient, validate_typed_output


INPUT = {"state": "genuine_model_inference=false; simulated/payment-not-applicable",
         "questions": {"grade": {"type": "score", "criteria": [{"level": 1.0}, {"level": 2.0}]}}}
RESULT = {"model": "fixture-model", "answers": {"grade": {
    "type": "score", "score": 0.5,
    "legend": {"0": {"level": 1}, "1": {"level": 2}},
    "probabilities": {"0": 0.5, "1": 0.5}, "confidence": 0.5}},
    "usage": {"input_tokens": 3, "output_tokens": 4}}
QUOTE = {"id": "00000000-0000-4000-8000-000000000001", "sellerId": "fixture-seller",
         "model": "fixture-model", "priceNanos": "1", "currency": "nanoXEC",
         "requestHash": "fixture-request", "schemaHash": "fixture-schema",
         "deliveryMode": "https", "inferenceContract": {"usageRequirement": "backend_reported_required"}}
RECEIPT = {"id": "00000000-0000-4000-8000-000000000002", "status": "succeeded",
           "sellerId": QUOTE["sellerId"], "priceNanos": QUOTE["priceNanos"],
           "requestHash": QUOTE["requestHash"], "schemaHash": QUOTE["schemaHash"],
           "result": RESULT}


def fixture_directory():
    directory = Path(__file__).resolve().parents[2] / ".local" / "python-reliability-tests"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def wait_for_dns_capacity(slots, count):
    until = time.monotonic() + 1
    while time.monotonic() < until:
        acquired = 0
        while acquired < count and slots.acquire(blocking=False):
            acquired += 1
        for _ in range(acquired):
            slots.release()
        if acquired == count:
            return
        time.sleep(0.01)
    raise AssertionError("DNS resolver permits were not released")


def generate_tls_fixture():
    """Create a test CA and loopback certificate without changing host trust."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "ZoKo local test CA")])
    server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "127.0.0.1")])
    ca_cert = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
        .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False,
            content_commitment=False, data_encipherment=False, key_agreement=False,
            key_cert_sign=True, crl_sign=True, encipher_only=False,
            decipher_only=False), critical=True)
        .sign(ca_key, hashes.SHA256()))
    server_cert = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca_name)
        .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256()))
    prefix = fixture_directory() / ("tls-" + uuid.uuid4().hex)
    paths = tuple(Path(str(prefix) + suffix) for suffix in ("-ca.pem", "-server.pem", "-server-key.pem"))
    try:
        for path, payload in zip(paths, (
            ca_cert.public_bytes(serialization.Encoding.PEM),
            server_cert.public_bytes(serialization.Encoding.PEM),
            server_key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8, serialization.NoEncryption()),
        )):
            with path.open("xb") as output:
                output.write(payload)
    except Exception:
        for path in paths:
            path.unlink(missing_ok=True)
        raise
    return paths


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def json_response(self, body):
        payload = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/v1/me":
            return self.json_response({"account": {"id": "fixture-account"}})
        if self.path == "/v1/catalog":
            self.server.public_reads.append(self.path)
            return self.json_response({"sellers": []})
        if self.path == "/v1/invalid-content":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")
            return
        if self.path in ("/v1/http10-length", "/v1/http11-close-length", "/v1/chunked", "/v1/truncated-length", "/v1/truncated-chunked"):
            try:
                wire = {
                    "/v1/http10-length": b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
                    "/v1/http11-close-length": b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
                    "/v1/chunked": b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
                    "/v1/truncated-length": b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{}",
                    "/v1/truncated-chunked": b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}",
                }[self.path]
                self.connection.sendall(wire)
                if self.path.startswith("/v1/truncated-"):
                    self.close_connection = True
            except OSError:
                pass
            return
        if self.path in ("/v1/close-delimited", "/v1/connection-close"):
            try:
                prefix = (b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"
                    if self.path == "/v1/close-delimited" else
                    b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{")
                self.connection.sendall(prefix)
                for _ in range(20):
                    self.connection.sendall(b" ")
                    time.sleep(0.04)
            except OSError:
                pass
            return
        if self.path == "/v1/slow-headers":
            try:
                self.connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Drip: ")
                for _ in range(20):
                    self.connection.sendall(b"x")
                    time.sleep(0.04)
                self.connection.sendall(b"\r\nContent-Length: 2\r\n\r\n{}")
            except OSError:
                pass
            return
        if self.path == "/v1/slow-body":
            try:
                self.connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n")
                for _ in range(20):
                    self.connection.sendall(b" ")
                    time.sleep(0.04)
            except OSError:
                pass
            return
        self.send_error(404)

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        if self.path == "/v1/quotes":
            return self.json_response(QUOTE)
        if self.path == "/v1/decisions":
            self.server.dispatches.append((self.headers.get("Idempotency-Key"), json.loads(body)))
            if len(self.server.dispatches) == 1:
                if self.server.first_decision == "timeout":
                    try:
                        self.connection.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Drip: ")
                        for _ in range(20):
                            self.connection.sendall(b"x")
                            time.sleep(0.04)
                    except OSError:
                        pass
                    return
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            return self.json_response(RECEIPT)
        self.send_error(404)


class FixtureServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, first_decision="drop"):
        super().__init__(("127.0.0.1", 0), FixtureHandler)
        self.dispatches = []
        self.public_reads = []
        self.accepted_connections = 0
        self.first_decision = first_decision
        self.thread = threading.Thread(target=self.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.shutdown()
        self.server_close()
        self.thread.join(timeout=2)

    def get_request(self):
        request = super().get_request()
        self.accepted_connections += 1
        return request

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            super().handle_error(request, client_address)


class TLSFixtureServer(FixtureServer):
    def __init__(self, server_cert, server_key):
        self.tls_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls_context.load_cert_chain(server_cert, server_key)
        super().__init__()

    def get_request(self):
        peer, address = super().get_request()
        return self.tls_context.wrap_socket(peer, server_side=True), address


class ReliabilityTests(unittest.TestCase):
    def test_dns_queue_and_thread_construction_fail_before_slot_acquisition(self):
        server = FixtureServer()
        slots = threading.BoundedSemaphore(1)
        original_init = threading.Thread.__init__

        def fail_dns_constructor(thread, *args, **kwargs):
            if kwargs.get("name") == "zoko-dns-resolver":
                raise RuntimeError("synthetic DNS thread constructor failure")
            return original_init(thread, *args, **kwargs)

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.2)
            with patch.object(zoko, "_DNS_SLOTS", slots), patch.object(zoko, "_DNS_MAX_INFLIGHT", 1):
                with patch("zoko.queue.Queue", side_effect=RuntimeError("synthetic DNS queue constructor failure")):
                    with self.assertRaisesRegex(RuntimeError, "queue constructor failure"):
                        client.request("GET", "/v1/me")
                self.assertTrue(slots.acquire(blocking=False))
                slots.release()
                with patch.object(threading.Thread, "__init__", fail_dns_constructor):
                    with self.assertRaisesRegex(RuntimeError, "thread constructor failure"):
                        client.request("GET", "/v1/me")
                self.assertTrue(slots.acquire(blocking=False))
                slots.release()
                self.assertEqual(client.request("GET", "/v1/me")["account"]["id"], "fixture-account")
                self.assertEqual(server.accepted_connections, 1)
        finally:
            server.close()

    def test_dns_start_failure_before_launch_keeps_slot_reserved(self):
        server = FixtureServer()
        slots = threading.BoundedSemaphore(1)
        original_start = threading.Thread.start

        def fail_before_start(thread):
            if thread.name == "zoko-dns-resolver":
                raise RuntimeError("synthetic prelaunch failure")
            return original_start(thread)

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.2)
            with patch.object(zoko, "_DNS_SLOTS", slots), patch.object(zoko, "_DNS_MAX_INFLIGHT", 1):
                with patch.object(threading.Thread, "start", fail_before_start):
                    with self.assertRaisesRegex(RuntimeError, "prelaunch failure"):
                        client.request("GET", "/v1/me")
                # Startup may have reached native launch before raising; fail closed.
                self.assertFalse(slots.acquire(blocking=False))
                with self.assertRaisesRegex(TimeoutError, "DNS resolver capacity \\(1\\) exceeded"):
                    client.request("GET", "/v1/me")
                self.assertEqual(server.accepted_connections, 0)
        finally:
            server.close()

    def test_dns_start_exception_after_launch_does_not_overadmit(self):
        server = FixtureServer()
        slots = threading.BoundedSemaphore(1)
        release = threading.Event()
        started = threading.Event()
        original_start = threading.Thread.start

        def blocked_lookup(*_args, **_kwargs):
            started.set()
            release.wait(5)
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", server.server_port))]

        def fail_after_start(thread):
            result = original_start(thread)
            if thread.name == "zoko-dns-resolver":
                raise RuntimeError("synthetic postlaunch failure")
            return result

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.3)
            with patch.object(zoko, "_DNS_SLOTS", slots), patch.object(zoko, "_DNS_MAX_INFLIGHT", 1), patch("socket.getaddrinfo", side_effect=blocked_lookup):
                with patch.object(threading.Thread, "start", fail_after_start):
                    with self.assertRaisesRegex(RuntimeError, "postlaunch failure"):
                        client.request("GET", "/v1/me")
                self.assertTrue(started.wait(0.5))
                self.assertFalse(slots.acquire(blocking=False))
                with self.assertRaisesRegex(TimeoutError, "DNS resolver capacity \\(1\\) exceeded"):
                    client.request("GET", "/v1/me")
                self.assertEqual(server.accepted_connections, 0)
                release.set()
                wait_for_dns_capacity(slots, 1)
                self.assertEqual(client.request("GET", "/v1/me")["account"]["id"], "fixture-account")
                self.assertEqual(server.accepted_connections, 1)
        finally:
            release.set()
            server.close()

    def test_dns_resolution_exception_releases_capacity(self):
        server = FixtureServer()
        slots = threading.BoundedSemaphore(1)
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.3)
            with patch.object(zoko, "_DNS_SLOTS", slots), patch.object(zoko, "_DNS_MAX_INFLIGHT", 1):
                with patch("socket.getaddrinfo", side_effect=socket.gaierror("synthetic lookup failure")):
                    with self.assertRaisesRegex(socket.gaierror, "synthetic lookup failure"):
                        client.request("GET", "/v1/me")
                wait_for_dns_capacity(slots, 1)
                self.assertEqual(client.request("GET", "/v1/me")["account"]["id"], "fixture-account")
                self.assertEqual(server.accepted_connections, 1)
        finally:
            server.close()

    def test_stuck_dns_workers_are_bounded_and_capacity_recovers(self):
        server = FixtureServer()
        release = threading.Event()
        entered = 0
        guard = threading.Lock()
        limit = zoko._DNS_MAX_INFLIGHT
        slots = threading.BoundedSemaphore(limit)

        def blocked_lookup(*_args, **_kwargs):
            nonlocal entered
            with guard:
                entered += 1
            release.wait(5)
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", server.server_port))]

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.08)
            with patch.object(zoko, "_DNS_SLOTS", slots), patch("socket.getaddrinfo", side_effect=blocked_lookup):
                for _ in range(limit):
                    with self.assertRaisesRegex(TimeoutError, "deadline exceeded"):
                        client.request("GET", "/v1/me")
                self.assertEqual(entered, limit)
                self.assertEqual(sum(t.name == "zoko-dns-resolver" for t in threading.enumerate()), limit)
                backpressured = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.5)
                started = time.monotonic()
                with self.assertRaisesRegex(TimeoutError, f"DNS resolver capacity \\({limit}\\) exceeded; preserve original identity"):
                    backpressured.request("GET", "/v1/me")
                self.assertLess(time.monotonic() - started, 0.2)
                self.assertEqual(server.accepted_connections, 0)
                release.set()
                wait_for_dns_capacity(slots, limit)
                recovered = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.5)
                self.assertEqual(recovered.request("GET", "/v1/me")["account"]["id"], "fixture-account")
                self.assertEqual(server.accepted_connections, 1)
        finally:
            release.set()
            server.close()

    def test_concurrent_clients_hit_dns_backpressure_without_late_dispatch(self):
        server = FixtureServer()
        release = threading.Event()
        limit = zoko._DNS_MAX_INFLIGHT
        slots = threading.BoundedSemaphore(limit)
        barrier = threading.Barrier(limit + 5)
        guard = threading.Lock()
        active = 0
        peak = 0
        results = []

        def blocked_lookup(*_args, **_kwargs):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            try:
                release.wait(5)
                return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", server.server_port))]
            finally:
                with guard:
                    active -= 1

        def request_once():
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.3)
            barrier.wait()
            try:
                client.request("GET", "/v1/me")
                outcome = "unexpected success"
            except TimeoutError as error:
                outcome = str(error)
            with guard:
                results.append(outcome)

        workers = [threading.Thread(target=request_once, daemon=True) for _ in range(limit + 4)]
        try:
            with patch.object(zoko, "_DNS_SLOTS", slots), patch("socket.getaddrinfo", side_effect=blocked_lookup):
                for worker in workers:
                    worker.start()
                barrier.wait()
                for worker in workers:
                    worker.join(timeout=1)
                    self.assertFalse(worker.is_alive())
                self.assertEqual(len(results), limit + 4)
                self.assertEqual(peak, limit)
                self.assertEqual(sum("DNS resolver capacity" in result for result in results), 4)
                self.assertEqual(sum("deadline exceeded" in result for result in results), limit)
                self.assertEqual(server.accepted_connections, 0)
                release.set()
                wait_for_dns_capacity(slots, limit)
                recovered = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.5)
                self.assertEqual(recovered.request("GET", "/v1/me")["account"]["id"], "fixture-account")
                self.assertEqual(server.accepted_connections, 1)
        finally:
            release.set()
            for worker in workers:
                worker.join(timeout=1)
            server.close()

    def test_dns_backpressure_preserves_purchase_identity(self):
        server = FixtureServer()
        release = threading.Event()
        slots = threading.BoundedSemaphore(1)
        journal_path = fixture_directory() / ("purchase-" + uuid.uuid4().hex + ".json")

        def blocked_lookup(*_args, **_kwargs):
            release.wait(5)
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", server.server_port))]

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.2)
            journal = client.prepare(journal_path, INPUT, {"maxPriceNanos": "1"})
            with self.assertRaises(Exception):
                client.execute(journal_path)
            attempt_before = Path(str(journal_path) + ".attempt.json").read_bytes()
            self.assertEqual(len(server.dispatches), 1)
            with patch.object(zoko, "_DNS_SLOTS", slots), patch.object(zoko, "_DNS_MAX_INFLIGHT", 1), patch("socket.getaddrinfo", side_effect=blocked_lookup):
                blocker = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.08)
                with self.assertRaises(TimeoutError):
                    blocker.request("GET", "/v1/me")
                with self.assertRaisesRegex(TimeoutError, "DNS resolver capacity \\(1\\) exceeded; preserve original identity"):
                    client.recover(journal_path)
                self.assertEqual(Path(str(journal_path) + ".attempt.json").read_bytes(), attempt_before)
                self.assertEqual(len(server.dispatches), 1)
                release.set()
                wait_for_dns_capacity(slots, 1)
                self.assertEqual(client.recover(journal_path), RECEIPT)
                self.assertEqual(Path(str(journal_path) + ".attempt.json").read_bytes(), attempt_before)
                self.assertEqual(len(server.dispatches), 2)
                self.assertEqual(server.dispatches[0], server.dispatches[1])
                self.assertEqual(server.dispatches[0][0], journal["idempotencyKey"])
        finally:
            release.set()
            server.close()
            for suffix in ("", ".attempt.json", ".decision.json", ".receipt.json"):
                Path(str(journal_path) + suffix).unlink(missing_ok=True)

    def test_score_numeric_equivalence_and_boolean_distinction(self):
        validate_typed_output(RESULT, INPUT, "fixture-model", True)
        nested = copy.deepcopy(INPUT)
        nested["questions"]["grade"]["criteria"][0] = {"values": [1.0, -0.0, 9007199254740993]}
        numeric = copy.deepcopy(RESULT)
        numeric["answers"]["grade"]["legend"]["0"] = {"values": [1, 0, 9007199254740992]}
        validate_typed_output(numeric, nested, "fixture-model", True)
        numeric["answers"]["grade"]["legend"]["0"]["values"][0] = float("inf")
        with self.assertRaises(ValueError):
            validate_typed_output(numeric, nested, "fixture-model", True)
        bad = copy.deepcopy(RESULT)
        bad["answers"]["grade"]["legend"]["0"]["level"] = True
        with self.assertRaises(ValueError):
            validate_typed_output(bad, INPUT, "fixture-model", True)

    def test_ambiguous_response_recovers_same_purchase_identity(self):
        server = FixtureServer()
        journal_path = fixture_directory() / ("purchase-" + uuid.uuid4().hex + ".json")
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key")
            journal = client.prepare(journal_path, INPUT, {"maxPriceNanos": "1"})
            with self.assertRaises(Exception):
                client.execute(journal_path)
            attempt_before = (Path(str(journal_path) + ".attempt.json")).read_bytes()
            receipt = client.recover(journal_path)
            self.assertEqual(receipt, RECEIPT)
            self.assertEqual((Path(str(journal_path) + ".attempt.json")).read_bytes(), attempt_before)
            self.assertEqual(len(server.dispatches), 2)
            self.assertEqual(server.dispatches[0], server.dispatches[1])
            self.assertEqual(server.dispatches[0][0], journal["idempotencyKey"])
            self.assertEqual(json.loads((Path(str(journal_path) + ".receipt.json")).read_text()), RECEIPT)
        finally:
            server.close()
            for suffix in ("", ".attempt.json", ".decision.json", ".receipt.json"):
                Path(str(journal_path) + suffix).unlink(missing_ok=True)

    def test_total_deadline_includes_slow_headers_and_body(self):
        server = FixtureServer()
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.2)
            for path in ("/v1/slow-headers", "/v1/slow-body", "/v1/close-delimited", "/v1/connection-close"):
                started = time.monotonic()
                with self.assertRaises(TimeoutError):
                    client.request("GET", path)
                self.assertLess(time.monotonic() - started, 0.7)
            self.assertEqual(server.dispatches, [])
        finally:
            server.close()

    def test_complete_close_length_and_chunked_responses_succeed(self):
        server = FixtureServer()
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key")
            for path in ("/v1/http10-length", "/v1/http11-close-length", "/v1/chunked"):
                self.assertEqual(client.request("GET", path), {})
        finally:
            server.close()

    def test_truncated_length_and_chunked_responses_fail(self):
        server = FixtureServer()
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.5)
            for path in ("/v1/truncated-length", "/v1/truncated-chunked"):
                with self.assertRaises((ValueError, http.client.IncompleteRead)):
                    client.request("GET", path)
        finally:
            server.close()

    def test_connect_failure_is_bounded_and_never_dispatches(self):
        with socket.socket() as closed:
            closed.bind(("127.0.0.1", 0))
            port = closed.getsockname()[1]
        client = ZokoHttpClient(f"http://127.0.0.1:{port}", "fixture-key", timeout=0.2)
        started = time.monotonic()
        with self.assertRaises((OSError, TimeoutError)):
            client.request("GET", "/v1/catalog")
        self.assertLess(time.monotonic() - started, 0.7)

    def test_first_socket_creation_failure_falls_back_to_next_address(self):
        server = FixtureServer()
        original_socket = socket.socket
        attempts = []

        def socket_factory(family, kind, protocol=0, *args, **kwargs):
            attempts.append(family)
            if family == socket.AF_INET6:
                raise OSError("synthetic first-family creation failure")
            return original_socket(family, kind, protocol, *args, **kwargs)

        addresses = [(socket.AF_INET6, socket.SOCK_STREAM, 0, "", ("::1", server.server_port, 0, 0)),
                     (socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", server.server_port))]
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key")
            with patch("socket.getaddrinfo", return_value=addresses), patch("socket.socket", side_effect=socket_factory):
                self.assertEqual(client.request("GET", "/v1/me")["account"]["id"], "fixture-account")
            self.assertIn(socket.AF_INET6, attempts)
            self.assertIn(socket.AF_INET, attempts)
        finally:
            server.close()

    def test_stalled_send_is_interrupted_without_dispatch(self):
        server = FixtureServer()
        original_send = socket.socket.sendall
        original_shutdown = socket.socket.shutdown
        released = threading.Event()

        def stalled_send(sock, data, *args, **kwargs):
            if threading.current_thread() is threading.main_thread():
                released.wait(1)
                raise OSError("synthetic stalled send interrupted")
            return original_send(sock, data, *args, **kwargs)

        def interrupt_send(sock, how):
            released.set()
            return original_shutdown(sock, how)

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.2)
            started = time.monotonic()
            with patch.object(socket.socket, "sendall", stalled_send), patch.object(socket.socket, "shutdown", interrupt_send):
                with self.assertRaises(TimeoutError):
                    client.request("POST", "/v1/decisions", {"fixture": True}, "fixed-fixture-key")
            self.assertLess(time.monotonic() - started, 0.7)
            self.assertEqual(server.dispatches, [])
        finally:
            server.close()

    def test_timeout_after_dispatch_recovers_original_key(self):
        server = FixtureServer(first_decision="timeout")
        journal_path = fixture_directory() / ("purchase-" + uuid.uuid4().hex + ".json")
        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key", timeout=0.2)
            journal = client.prepare(journal_path, INPUT, {"maxPriceNanos": "1"})
            with self.assertRaises(TimeoutError):
                client.execute(journal_path)
            attempt_before = Path(str(journal_path) + ".attempt.json").read_bytes()
            receipt = client.recover(journal_path)
            self.assertEqual(receipt, RECEIPT)
            self.assertEqual(Path(str(journal_path) + ".attempt.json").read_bytes(), attempt_before)
            self.assertEqual(server.dispatches[0], server.dispatches[1])
            self.assertEqual(server.dispatches[0][0], journal["idempotencyKey"])
        finally:
            server.close()
            for suffix in ("", ".attempt.json", ".decision.json", ".receipt.json"):
                Path(str(journal_path) + suffix).unlink(missing_ok=True)

    def test_validation_error_closes_response(self):
        server = FixtureServer()
        original_close = http.client.HTTPResponse.close
        closed = []

        def checked_close(response):
            closed.append(True)
            return original_close(response)

        try:
            client = ZokoHttpClient(f"http://127.0.0.1:{server.server_port}", "fixture-key")
            with patch.object(http.client.HTTPResponse, "close", checked_close):
                with self.assertRaises(ValueError):
                    client.request("GET", "/v1/invalid-content")
            self.assertTrue(closed)
        finally:
            server.close()

    def test_verified_loopback_tls_succeeds(self):
        try:
            ca_path, server_cert, server_key = generate_tls_fixture()
        except ImportError:
            self.skipTest("cryptography is required for generated TLS certificates")
        server = None
        try:
            server = TLSFixtureServer(server_cert, server_key)
            client = ZokoHttpClient(f"https://127.0.0.1:{server.server_port}", "fixture-key")
            with self.assertRaises(ssl.SSLCertVerificationError):
                client.request("GET", "/v1/me")
            context = ssl.create_default_context(cafile=ca_path)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(context.check_hostname)
            with patch("ssl._create_default_https_context", return_value=context):
                self.assertEqual(client.request("GET", "/v1/me")["account"]["id"], "fixture-account")
                wrong_host = ZokoHttpClient(f"https://localhost:{server.server_port}", "fixture-key")
                with self.assertRaises(ssl.SSLCertVerificationError):
                    wrong_host.request("GET", "/v1/me")
            self.assertEqual(server.accepted_connections, 3)
        finally:
            try:
                if server is not None:
                    server.close()
            finally:
                for path in (ca_path, server_cert, server_key):
                    path.unlink(missing_ok=True)

    def test_stalled_tls_handshake_uses_remaining_tcp_budget(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        accepted = threading.Event()

        def stall_handshake():
            try:
                peer, _ = listener.accept()
                accepted.set()
                with peer:
                    time.sleep(0.7)
            except OSError:
                pass

        thread = threading.Thread(target=stall_handshake, daemon=True)
        thread.start()
        original_connect = socket.socket.connect
        original_handshake = ssl.SSLSocket.do_handshake
        handshake_budgets = []

        def delayed_connect(sock, address):
            time.sleep(0.12)
            return original_connect(sock, address)

        def checked_handshake(sock, *args, **kwargs):
            handshake_budgets.append(sock.gettimeout())
            return original_handshake(sock, *args, **kwargs)

        try:
            client = ZokoHttpClient(f"https://127.0.0.1:{listener.getsockname()[1]}", "fixture-key", timeout=0.3)
            started = time.monotonic()
            with patch.object(socket.socket, "connect", delayed_connect), patch.object(ssl.SSLSocket, "do_handshake", checked_handshake):
                with self.assertRaises(TimeoutError):
                    client.request("GET", "/v1/catalog")
            self.assertEqual(len(handshake_budgets), 1)
            self.assertGreater(handshake_budgets[0], 0)
            self.assertLess(handshake_budgets[0], 0.25)
            self.assertLess(time.monotonic() - started, 0.6)
            self.assertTrue(accepted.is_set())
        finally:
            listener.close()
            thread.join(timeout=1)

    def test_slow_dns_cannot_dispatch_after_total_deadline(self):
        server = FixtureServer()

        def slow_lookup(*_args, **_kwargs):
            time.sleep(0.4)
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("127.0.0.1", server.server_port))]

        try:
            client = ZokoHttpClient("https://fixture.invalid", "fixture-key", timeout=0.2)
            with patch("socket.getaddrinfo", side_effect=slow_lookup):
                started = time.monotonic()
                with self.assertRaises(TimeoutError):
                    client.request("GET", "/v1/catalog")
                self.assertLess(time.monotonic() - started, 0.7)
                time.sleep(0.3)  # Let the DNS worker finish after the caller returned.
            self.assertEqual(server.public_reads, [])
            self.assertEqual(server.accepted_connections, 0)
        finally:
            server.close()


if __name__ == "__main__":
    unittest.main()
