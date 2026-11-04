from unittest.mock import AsyncMock

from fastapi.testclient import TestClient

from app.main import app
from app.services.chat import get_chat_service


def test_demo_api_with_fake_llm_and_isolated_storage(monkeypatch):
    llm = AsyncMock(return_value="DM.Brake = 0.5 | 1000 | Abs")
    monkeypatch.setattr(get_chat_service(), "_run_claude", llm)
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"
        defaults = client.get("/api/settings/chat").json()
        response = client.post("/api/chat", json={
            "message": "Stop the car",
            "promptTemplateId": defaults["defaultPromptTemplateId"],
            "model": "sonnet",
        })
        assert response.status_code == 200, response.text
        chat = response.json()
        assert chat["responses"] == ["DM.Brake = 0.5 | 1000 | Abs"]
        messages = client.get(f"/api/conversations/{chat['conversationId']}/messages").json()
        assert [message["role"] for message in messages] == ["user", "assistant"]
        assert all("createdAt" in message for message in messages)
        llm.assert_awaited_once()

        trigger = client.post("/api/triggers", json={
            "name": "smoke", "expression": "Car.v < 1", "message": "stop",
            "useRuleControl": True, "debugAction": "DM.Brake = 1 | 1000 | Abs",
        })
        assert trigger.status_code == 200, trigger.text
        assert client.get(f"/api/triggers/{trigger.json()['id']}").json()["useRuleControl"] is True
        # Disconnected demo state must reject commands/monitoring without opening a socket.
        assert client.get("/api/carmaker/status").json()["connected"] is False
        assert client.post("/api/carmaker/monitoring", json={"active": True}).status_code == 400
        assert client.get("/api/carmaker/telemetry").status_code == 503
        assert client.post("/api/carmaker/command", json={"command": "StartSim"}).status_code == 400

        created = client.post("/api/maps", json={
            "name": "smoke", "description": "offline", "nodeXml": "<nodes/>", "edgeXml": "<edges/>",
        })
        assert created.status_code == 200, created.text
        map_id = created.json()["id"]
        assert client.put(f"/api/maps/{map_id}", json={"name": "smoke edited"}).status_code == 200
        assert client.get(f"/api/maps/{map_id}").json()["name"] == "smoke edited"
        assert client.delete(f"/api/maps/{map_id}").status_code == 200
