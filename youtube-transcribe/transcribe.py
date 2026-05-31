#!/usr/bin/env python3
"""Transcribe a YouTube video with Deepgram.

Pipeline: yt-dlp downloads the audio -> POST it to Deepgram's pre-recorded
API (nova-3) -> save a plain-text transcript and the full JSON response.

Only the Python standard library is used, so there is nothing to pip install
(handy on PEP 668 "externally managed" systems).

Usage:
    export DEEPGRAM_API_KEY=...          # or put it in a .env file (see .env.example)
    ./transcribe.py "https://www.youtube.com/watch?v=VIDEO_ID"

    # options
    ./transcribe.py URL --model nova-3 --language multi --diarize
    ./transcribe.py URL --keep-audio -o output
"""

import argparse
import http.client
import json
import os
import socket
import ssl
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

DEEPGRAM_HOST = "api.deepgram.com"
DEEPGRAM_PATH = "/v1/listen"
DOH_URL = "https://dns.google/resolve"


def resolve_pool(host: str, doh_samples: int = 15) -> list:
    """Collect the full set of A records for `host`.

    Deepgram's DNS hands out ONE rotating A record per query, and the local
    resolver caches it for the TTL, so a single lookup (or repeated local
    lookups) only sees one IP. Querying a DNS-over-HTTPS endpoint repeatedly
    bypasses the local cache and samples the whole rotation. Local resolution
    is merged in as a fallback in case DoH itself is unreachable."""
    pool = []
    for _ in range(doh_samples):
        try:
            url = f"{DOH_URL}?{urllib.parse.urlencode({'name': host, 'type': 'A'})}"
            with urllib.request.urlopen(url, timeout=10) as response:
                answers = json.load(response).get("Answer", [])
            for answer in answers:
                ip = answer.get("data")
                if answer.get("type") == 1 and ip and ip not in pool:
                    pool.append(ip)
        except Exception:
            break  # DoH unavailable; fall back to local resolution below
    for _ in range(6):
        try:
            ip = socket.gethostbyname(host)
            if ip not in pool:
                pool.append(ip)
        except socket.gaierror:
            break
    return pool


def reachable_ip(host: str, port: int = 443, connect_timeout: int = 5) -> str:
    """Return the first IP from the resolved pool that accepts a TCP
    connection, so we never hang on an unroutable address. Deepgram rotates
    DNS over several IPs and some may be unreachable from a given network."""
    pool = resolve_pool(host)
    if not pool:
        sys.exit(f"ERROR: could not resolve {host} (DNS and DoH both failed)")

    dead = []
    for ip in pool:
        try:
            socket.create_connection((ip, port), timeout=connect_timeout).close()
            if dead:
                print(f"      (skipped unreachable {host} IPs: {', '.join(dead)})")
            return ip
        except OSError:
            dead.append(ip)
    sys.exit(
        f"ERROR: none of the resolved {host} IPs accept connections from this "
        f"network ({', '.join(pool)}). This is a routing/firewall issue on your "
        f"host (the 38.x.x.x block appears blocked), not the script."
    )


def load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, ignores blanks and # comments."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def get_api_key() -> str:
    load_dotenv(Path(__file__).parent / ".env")
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        sys.exit(
            "ERROR: DEEPGRAM_API_KEY is not set.\n"
            "  export DEEPGRAM_API_KEY=your_key   (or create a .env file)"
        )
    return key


def download_audio(url: str, workdir: Path) -> Path:
    """Download bestaudio as m4a via yt-dlp. Returns the audio file path."""
    out_template = str(workdir / "audio.%(ext)s")
    print(f"[1/3] Downloading audio with yt-dlp ...", flush=True)
    subprocess.run(
        [
            "yt-dlp",
            "-f", "bestaudio/best",
            "-x", "--audio-format", "m4a",
            "--no-playlist",
            "-o", out_template,
            url,
        ],
        check=True,
    )
    files = list(workdir.glob("audio.*"))
    if not files:
        sys.exit("ERROR: yt-dlp produced no audio file.")
    return files[0]


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection dialed to a fixed IP while keeping SNI, the cert
    hostname, and the Host header on the real hostname."""

    def __init__(self, hostname: str, ip: str, **kwargs):
        self._ssl_context = ssl.create_default_context()
        super().__init__(hostname, 443, context=self._ssl_context, **kwargs)
        self._ip = ip

    def connect(self):
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
        self.sock = self._ssl_context.wrap_socket(sock, server_hostname=self.host)


def deepgram_transcribe(audio_path: Path, api_key: str, params: dict) -> dict:
    """POST raw audio bytes to Deepgram and return the parsed JSON response.

    The connection is pinned to a reachable IP (see reachable_ip) while SNI,
    the Host header, and TLS certificate verification all stay on the real
    hostname, so cert validation is unaffected."""
    query = urllib.parse.urlencode(params)
    size_mb = audio_path.stat().st_size / 1_048_576
    print(f"[2/3] Uploading {size_mb:.1f} MB to Deepgram ({params['model']}) ...", flush=True)

    ip = reachable_ip(DEEPGRAM_HOST)
    conn = PinnedHTTPSConnection(DEEPGRAM_HOST, ip, timeout=900)
    try:
        conn.request(
            "POST",
            f"{DEEPGRAM_PATH}?{query}",
            body=audio_path.read_bytes(),
            headers={
                "Host": DEEPGRAM_HOST,
                "Authorization": f"Token {api_key}",
                "Content-Type": "audio/m4a",
            },
        )
        response = conn.getresponse()
        body = response.read()
        if response.status != 200:
            sys.exit(
                f"ERROR: Deepgram returned HTTP {response.status}\n"
                f"{body.decode('utf-8', 'replace')}"
            )
        return json.loads(body)
    finally:
        conn.close()


def extract_transcript(result: dict, diarize: bool) -> str:
    """Pull readable text out of the Deepgram response."""
    channel = result["results"]["channels"][0]
    alt = channel["alternatives"][0]

    if diarize and alt.get("words"):
        lines, current_speaker, buffer = [], None, []
        for word in alt["words"]:
            speaker = word.get("speaker", 0)
            token = word.get("punctuated_word", word["word"])
            if speaker != current_speaker:
                if buffer:
                    lines.append(f"Speaker {current_speaker}: {' '.join(buffer)}")
                current_speaker, buffer = speaker, [token]
            else:
                buffer.append(token)
        if buffer:
            lines.append(f"Speaker {current_speaker}: {' '.join(buffer)}")
        return "\n".join(lines)

    paragraphs = alt.get("paragraphs", {}).get("transcript")
    return paragraphs if paragraphs else alt.get("transcript", "")


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe a YouTube video with Deepgram.")
    parser.add_argument("url", help="YouTube video URL")
    parser.add_argument("--model", default="nova-3", help="Deepgram model (default: nova-3)")
    parser.add_argument(
        "--language",
        default=None,
        help="Force a language code (e.g. en, pt, multi). Default: auto-detect.",
    )
    parser.add_argument("--diarize", action="store_true", help="Label speakers")
    parser.add_argument("--keep-audio", action="store_true", help="Keep the downloaded audio file")
    parser.add_argument("-o", "--output-dir", default="output", help="Output directory")
    args = parser.parse_args()

    api_key = get_api_key()
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    params = {
        "model": args.model,
        "smart_format": "true",
        "punctuate": "true",
        "paragraphs": "true",
    }
    if args.diarize:
        params["diarize"] = "true"
    if args.language:
        params["language"] = args.language
    else:
        params["detect_language"] = "true"

    workdir = Path(tempfile.mkdtemp(prefix="yt-transcribe-"))
    try:
        audio = download_audio(args.url, workdir)
        result = deepgram_transcribe(audio, api_key, params)

        print("[3/3] Saving transcript ...", flush=True)
        meta = result.get("metadata", {})
        detected = (
            result["results"]["channels"][0].get("detected_language")
            or meta.get("language")
            or args.language
            or "unknown"
        )
        base = output_dir / "transcript"
        transcript = extract_transcript(result, args.diarize)
        base.with_suffix(".txt").write_text(transcript + "\n", encoding="utf-8")
        base.with_suffix(".json").write_text(json.dumps(result, indent=2), encoding="utf-8")

        if args.keep_audio:
            kept = output_dir / audio.name
            kept.write_bytes(audio.read_bytes())
            print(f"      audio kept at {kept}")

        duration = meta.get("duration", 0)
        words = len(result["results"]["channels"][0]["alternatives"][0].get("words", []))
        print(
            f"\nDone. language={detected}  audio={duration:.0f}s  words={words}\n"
            f"  {base.with_suffix('.txt')}\n"
            f"  {base.with_suffix('.json')}"
        )
    finally:
        if not args.keep_audio:
            for f in workdir.glob("*"):
                f.unlink()
            workdir.rmdir()


if __name__ == "__main__":
    main()
