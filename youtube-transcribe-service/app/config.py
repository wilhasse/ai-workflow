import os


class Config:
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5005"))
    deepgram_api_key = os.environ.get("DEEPGRAM_API_KEY", "")
    model = os.environ.get("DEEPGRAM_STT_MODEL", "nova-3")
    doris = {
        "host": os.environ.get("DORIS_HOST", "10.1.0.7"),
        "port": int(os.environ.get("DORIS_PORT", "9030")),
        "user": os.environ.get("DORIS_USER", "root"),
        "password": os.environ.get("DORIS_PASSWORD", ""),
        "database": os.environ.get("DORIS_DATABASE", "agent_history"),
    }


config = Config()
