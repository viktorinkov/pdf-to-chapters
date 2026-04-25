from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import webbrowser


def _pick_free_port(host: str = "127.0.0.1") -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return int(s.getsockname()[1])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="walnut", description="Add chapter bookmarks to PDFs.")
    parser.add_argument("--port", type=int, default=None, help="Port to bind. Default: pick free.")
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true", help="Skip auto-opening the browser.")
    parser.add_argument(
        "--llm-mode",
        choices=["on", "off"],
        default=None,
        help="Set WALNUT_LLM_MODE; off skips the LLM (TOC only).",
    )
    args = parser.parse_args(argv)

    if args.llm_mode is not None:
        os.environ["WALNUT_LLM_MODE"] = args.llm_mode

    host = args.host
    port = args.port if args.port is not None else _pick_free_port(host)
    url = f"http://{host}:{port}"
    print(f"walnut is running at {url}", flush=True)

    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        import uvicorn  # imported lazily so tests don't need it.
    except ImportError as e:  # pragma: no cover
        print(f"uvicorn is required: {e}", file=sys.stderr)
        return 2

    uvicorn.run("walnut.server:app", host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
