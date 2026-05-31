import sys
from pathlib import Path

# The shared transcription core lives in ../youtube-transcribe (canonical copy).
# In the Docker image it is COPYed to the app root; for local tests add it to path.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "youtube-transcribe"))
