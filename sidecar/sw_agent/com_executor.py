"""sw_agent.com_executor — the ONE thread that touches SolidWorks COM (P122).

SolidWorks COM objects live in a single-threaded apartment. A proxy obtained on
thread A cannot be used from thread B; pywin32 reports that as a cryptic
``com_error`` or ``AttributeError: SldWorks.Application.<member>`` at attribute
lookup — the exact symptom P23 chased when the warmup thread's connection leaked
into the RPC thread. P23 answered by keeping the two threads' objects apart; that
is a rule people must remember. This module removes the rule: every COM call is
submitted to one dedicated STA worker and awaited from wherever the caller is.

Design (mirrors what the other pywin32 SolidWorks bridge landed after the same bug):
  - start(): spawn the worker, CoInitialize on it, wait until ready
  - run(fn): enqueue a zero-arg callable, block for its result / exception
  - stop(): drain and CoUninitialize

Works without pywin32 (CI, tests): CoInitialize is skipped, the queue semantics
are identical.
"""
from __future__ import annotations

import queue
import threading
from concurrent.futures import Future
from typing import Any, Callable, TypeVar

T = TypeVar("T")
_SHUTDOWN = object()


class ComExecutor:
    def __init__(self, name: str = "sw-com") -> None:
        self._name = name
        self._q: queue.Queue = queue.Queue()
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._init_error: str | None = None

    # ---- lifecycle ----
    def start(self, timeout: float = 10.0) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._ready.clear()
        self._init_error = None
        self._thread = threading.Thread(target=self._worker, name=self._name, daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout):
            raise RuntimeError(f"ComExecutor {self._name} did not initialise within {timeout}s")
        if self._init_error:
            raise RuntimeError(f"ComExecutor {self._name}: {self._init_error}")

    def stop(self, timeout: float = 5.0) -> None:
        if self._thread is None or not self._thread.is_alive():
            return
        self._q.put(_SHUTDOWN)
        self._thread.join(timeout)
        self._thread = None

    @property
    def alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def on_worker_thread(self) -> bool:
        return threading.current_thread() is self._thread

    # ---- dispatch ----
    def submit(self, fn: Callable[[], T]) -> Future[T]:
        if not self.alive:
            raise RuntimeError(f"ComExecutor {self._name} is not running")
        fut: Future = Future()
        self._q.put((fn, fut))
        return fut

    def run(self, fn: Callable[[], T], timeout: float | None = None) -> T:
        # Re-entrant: a tool that (through a helper) calls run() again from the worker
        # must not deadlock waiting on itself. Execute inline in that case.
        if self.on_worker_thread():
            return fn()
        return self.submit(fn).result(timeout=timeout)

    # ---- worker ----
    def _worker(self) -> None:
        try:
            import pythoncom  # type: ignore
            # Explicit STA. CoInitialize() defaults to it, but say so — this is the whole point.
            pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
        except ImportError:
            pythoncom = None  # CI / non-Windows: queue semantics only
        except Exception as e:  # noqa: BLE001
            self._init_error = f"CoInitializeEx failed: {e!r}"
            self._ready.set()
            return
        self._ready.set()
        try:
            while True:
                item = self._q.get()
                if item is _SHUTDOWN:
                    break
                fn, fut = item
                if not fut.set_running_or_notify_cancel():
                    continue
                try:
                    fut.set_result(fn())
                except BaseException as e:  # noqa: BLE001 — propagate everything to the caller
                    fut.set_exception(e)
        finally:
            if pythoncom is not None:
                try:
                    pythoncom.CoUninitialize()
                except Exception:  # noqa: BLE001
                    pass


_DEFAULT: ComExecutor | None = None


def default() -> ComExecutor:
    """Process-wide executor, started on first use."""
    global _DEFAULT
    if _DEFAULT is None or not _DEFAULT.alive:
        _DEFAULT = ComExecutor()
        _DEFAULT.start()
    return _DEFAULT


def run(fn: Callable[[], Any], timeout: float | None = None):
    return default().run(fn, timeout)
