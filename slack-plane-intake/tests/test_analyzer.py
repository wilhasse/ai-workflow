from __future__ import annotations

import json

import httpx
import pytest
import respx
from PIL import Image

from slack_plane_intake.analyzer import Analyzer
from slack_plane_intake.config import ModelConfig
from slack_plane_intake.models import SourceAttachment


def model_config():
    return ModelConfig(
        base_url="https://models.test/v1",
        api_key="secret",
        text_models=("kimi-k3", "qwen3.8-max", "deepseek/deepseek-v4-pro"),
        vision_models=("kimi-k3", "qwen3.8-max", "gpt-5.6-terra"),
        timeout_seconds=10,
    )


def valid_response(title="API failure"):
    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps(
                        {
                            "title": title,
                            "summary": "The API returned HTTP 500.",
                            "confirmed_facts": ["HTTP 500 was reported."],
                            "inferences": [],
                            "missing_information": ["Request ID"],
                            "warnings": [],
                        }
                    )
                }
            }
        ]
    }


@respx.mock
@pytest.mark.asyncio
async def test_text_chain_falls_back_from_k3_to_qwen(limits, source_message):
    route = respx.post("https://models.test/v1/chat/completions")
    route.side_effect = [
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(200, json=valid_response()),
    ]
    analyzer = Analyzer(model_config(), limits)
    result = await analyzer.analyze(source_message)
    await analyzer.close()
    assert result.model_used == "qwen3.8-max"
    assert result.analysis_kind == "text"
    assert route.call_count == 3
    assert route.calls[0].request.read()
    assert "temperature" not in json.loads(route.calls[0].request.content)


@respx.mock
@pytest.mark.asyncio
async def test_text_chain_uses_deepseek_as_third_model(limits, source_message):
    route = respx.post("https://models.test/v1/chat/completions")
    route.side_effect = [
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(200, json=valid_response("DeepSeek result")),
    ]
    analyzer = Analyzer(model_config(), limits)
    result = await analyzer.analyze(source_message)
    await analyzer.close()
    assert result.model_used == "deepseek/deepseek-v4-pro"


@respx.mock
@pytest.mark.asyncio
async def test_visual_chain_uses_terra_not_deepseek(tmp_path, limits, source_message):
    image_path = tmp_path / "screen.png"
    Image.new("RGB", (20, 20), "red").save(image_path)
    visual_message = source_message.model_copy(
        update={
            "attachments": (
                SourceAttachment(
                    file_id="F1",
                    name="screen.png",
                    mime_type="image/png",
                    size=image_path.stat().st_size,
                    sha256="abc",
                    local_path=image_path,
                ),
            )
        }
    )
    route = respx.post("https://models.test/v1/chat/completions")
    route.side_effect = [
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(500),
        httpx.Response(200, json=valid_response("Visual result")),
    ]
    analyzer = Analyzer(model_config(), limits)
    result = await analyzer.analyze(visual_message)
    await analyzer.close()
    assert result.model_used == "gpt-5.6-terra"
    assert result.analysis_kind == "vision"
    requested_models = [
        json.loads(call.request.content)["model"] for call in route.calls
    ]
    assert "deepseek/deepseek-v4-pro" not in requested_models
    assert requested_models[-1] == "gpt-5.6-terra"


@respx.mock
@pytest.mark.asyncio
async def test_invalid_json_retries_same_model(limits, source_message):
    route = respx.post("https://models.test/v1/chat/completions")
    route.side_effect = [
        httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]}),
        httpx.Response(200, json=valid_response()),
    ]
    analyzer = Analyzer(model_config(), limits)
    result = await analyzer.analyze(source_message)
    await analyzer.close()
    assert result.model_used == "kimi-k3"
    assert route.call_count == 2
