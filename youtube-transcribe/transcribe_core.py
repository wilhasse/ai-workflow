"""Shared, dependency-free transcription core.

Used by both the CLI (transcribe.py) and youtube-transcribe-service. Only the
Python standard library is used here so the module can be vendored into the
service image without extra installs. yt-dlp/ffmpeg are invoked as subprocesses.
"""

import http.client
import json
import re
import socket
import ssl
import subprocess
import urllib.parse
import urllib.request
from pathlib import Path

DEEPGRAM_HOST = "api.deepgram.com"
DEEPGRAM_PATH = "/v1/listen"
DOH_URL = "https://dns.google/resolve"

_VIDEO_ID_RE = re.compile(r"(?:v=|/embed/|youtu\.be/|/v/|/shorts/)([0-9A-Za-z_-]{11})")


def video_id_from_url(url: str) -> str | None:
    """Extract the 11-char YouTube id from common URL shapes. No network."""
    match = _VIDEO_ID_RE.search(url or "")
    return match.group(1) if match else None


def resolve_pool(host: str, doh_samples: int = 15) -> list:
    """Collect the full set of A records for `host`.

    Deepgram hands out one rotating A record per query and the local resolver
    caches it for the TTL, so a single lookup only sees one IP. Querying a
    DNS-over-HTTPS endpoint repeatedly bypasses the cache and samples the whole
    rotation. Local resolution is merged in as a fallback if DoH is blocked."""
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
            break
    for _ in range(6):
        try:
            ip = socket.gethostbyname(host)
            if ip not in pool:
                pool.append(ip)
        except socket.gaierror:
            break
    return pool


def reachable_ip(host: str, port: int = 443, connect_timeout: int = 5) -> str:
    """First IP from the resolved pool that accepts a TCP connection."""
    pool = resolve_pool(host)
    if not pool:
        raise RuntimeError(f"could not resolve {host} (DNS and DoH both failed)")
    dead = []
    for ip in pool:
        try:
            socket.create_connection((ip, port), timeout=connect_timeout).close()
            return ip
        except OSError:
            dead.append(ip)
    raise RuntimeError(
        f"none of the resolved {host} IPs accept connections from this network "
        f"({', '.join(pool)}); routing/firewall issue on this host"
    )


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection dialed to a fixed IP while keeping SNI, cert hostname,
    and the Host header on the real hostname."""

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


def fetch_metadata(url: str) -> dict:
    """Return {video_id, title, channel, duration_seconds} via yt-dlp (network)."""
    proc = subprocess.run(
        ["yt-dlp", "--no-warnings", "--skip-download", "--no-playlist",
         "--print", "%(id)s\t%(title)s\t%(channel)s\t%(duration)s", url],
        capture_output=True, text=True, check=True,
    )
    parts = proc.stdout.strip().split("\t")
    while len(parts) < 4:
        parts.append("")
    vid, title, channel, duration = parts[:4]
    try:
        duration_seconds = int(float(duration))
    except (TypeError, ValueError):
        duration_seconds = 0
    return {
        "video_id": vid or video_id_from_url(url),
        "title": title,
        "channel": channel,
        "duration_seconds": duration_seconds,
    }


def download_audio(url: str, workdir: Path) -> Path:
    """Download bestaudio as m4a via yt-dlp. Returns the audio file path."""
    out_template = str(workdir / "audio.%(ext)s")
    subprocess.run(
        ["yt-dlp", "-f", "bestaudio/best", "-x", "--audio-format", "m4a",
         "--no-playlist", "-o", out_template, url],
        check=True,
    )
    files = list(workdir.glob("audio.*"))
    if not files:
        raise RuntimeError("yt-dlp produced no audio file")
    return files[0]


def deepgram_transcribe(audio_path: Path, api_key: str, params: dict) -> dict:
    """POST raw audio bytes to Deepgram and return the parsed JSON response."""
    query = urllib.parse.urlencode(params)
    ip = reachable_ip(DEEPGRAM_HOST)
    conn = PinnedHTTPSConnection(DEEPGRAM_HOST, ip, timeout=900)
    try:
        conn.request(
            "POST", f"{DEEPGRAM_PATH}?{query}",
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
            raise RuntimeError(
                f"Deepgram HTTP {response.status}: {body.decode('utf-8', 'replace')[:500]}"
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


def detected_language(result: dict, fallback: str = "unknown") -> str:
    channel = result["results"]["channels"][0]
    meta = result.get("metadata", {})
    return channel.get("detected_language") or meta.get("language") or fallback
