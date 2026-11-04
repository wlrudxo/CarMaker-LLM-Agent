import threading
import time
from unittest.mock import AsyncMock, Mock

import pytest

from app.schemas.triggers import Trigger, utc_now
from app.services.action_service import ActionService
from app.services.trigger_executor import TriggerExecutor
from app.services.triggers import TriggerService
from app.schemas.triggers import CreateTriggerRequest
from app.schemas.carmaker import build_telemetry
from app.services.carmaker import CarMakerService


def trigger():
    return Trigger(id=1, name='offline', expression='Car.v > 0', message='brake',
                   created_at=utc_now(), updated_at=utc_now())


def carmaker_mock():
    carmaker = Mock()
    carmaker._lock = threading.RLock()
    carmaker.reset_controls.side_effect = lambda: CarMakerService.reset_controls(carmaker)
    return carmaker


@pytest.mark.parametrize('outcome', ['error', 'cancel'])
def test_llm_failure_or_cancel_never_resumes(outcome):
    carmaker = carmaker_mock()
    cancel = threading.Event()
    async def response(*args, **kwargs):
        if outcome == 'error':
            raise RuntimeError('fake LLM failed')
        cancel.set()
        return 'DM.Gas = 1 | 1000 | Abs'
    chat = Mock(generate_trigger_response=AsyncMock(side_effect=response))
    executor = TriggerExecutor(carmaker, ActionService(carmaker), chat)
    events = []
    executor.execute(trigger(), {'Car.v': 10}, cancel, lambda: True, Mock(), Mock(), events.append)
    commands = [call.args[0] for call in carmaker.execute_command.call_args_list]
    assert 'DVAWrite SC.TAccel 1.0 30000 Abs' not in commands
    assert 'StopSim' in commands
    assert not any('DM.Gas 1' in cmd for cmd in commands)
    assert events[-1].type == 'error'


def test_reset_preserves_worker_liveness_and_event_cursor(tmp_path):
    service = TriggerService(tmp_path / 'triggers.json', Mock(), Mock())
    service._is_executing = True
    service._active_trigger_id = 1
    service._monitoring_active = True
    service._next_event_id = 42
    service.reset_runtime_state()
    assert service.get_runtime_status().is_executing
    assert service._cancel_event.is_set()
    assert service._next_event_id == 42
    with pytest.raises(RuntimeError, match='execution'):
        service.set_monitoring_state(True)


@pytest.mark.parametrize('stop_path', ['/api/triggers/monitoring', '/api/carmaker/reset-control',
                                     '/api/carmaker/simulation/stop', '/api/carmaker/command'])
def test_mock_api_stop_during_slow_llm_drains_worker_before_restart(tmp_path, monkeypatch, stop_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.carmaker import get_carmaker_service
    from app.services.action_service import get_action_service
    from app.services.triggers import get_trigger_service

    entered, release = threading.Event(), threading.Event()
    async def response(*args, **kwargs):
        entered.set()
        assert release.wait(4), 'test failed to release mock LLM'
        return 'DM.Gas = 1 | 1000 | Abs'

    carmaker = carmaker_mock()
    carmaker.get_status.return_value.connected = True
    carmaker.is_monitoring_active.return_value = True
    carmaker.get_telemetry.return_value = build_telemetry({'Car.v': 10})
    carmaker.execute_command.return_value = 'O'
    carmaker.stop_simulation.side_effect = lambda: carmaker.execute_command('StopSim')
    actions = ActionService(carmaker)
    executor = TriggerExecutor(carmaker, actions, Mock(generate_trigger_response=AsyncMock(side_effect=response)))
    service = TriggerService(tmp_path / 'triggers.json', carmaker, executor)
    monkeypatch.setattr(service, '_ensure_monitor_thread', lambda: None)
    service.create_trigger(CreateTriggerRequest(name='first', expression='Car.v > 0', message='test'))
    service.create_trigger(CreateTriggerRequest(name='queued', expression='Car.v > 0', message='test'))
    overrides = {get_carmaker_service: lambda: carmaker, get_action_service: lambda: actions,
                 get_trigger_service: lambda: service}
    previous = app.dependency_overrides.copy()
    app.dependency_overrides.update(overrides)
    worker = None
    try:
        with TestClient(app) as client:
            assert client.post('/api/triggers/monitoring', json={'active': True}).json() is True
            service._tick_monitoring()
            assert entered.wait(2)
            worker = service._worker_thread
            # Longer than one UI polling period: temporary execution must keep user intent true.
            time.sleep(.55)
            status = client.get('/api/triggers/runtime-status').json()
            assert status['monitoringActive'] and status['isExecuting']
            assert status['queuedCount'] == 1
            body = {'active': False} if stop_path.endswith('/monitoring') else {'command': 'StopSim'}
            stopped = client.post(stop_path, json=body)
            assert stopped.status_code == 200, stopped.text
            status = client.get('/api/triggers/runtime-status').json()
            assert not status['monitoringActive'] and status['isExecuting']
            assert status['queuedCount'] == 0
            assert client.post('/api/triggers/monitoring', json={'active': True}).status_code == 409
            release.set()
            worker.join(3)
            assert not worker.is_alive()
            assert not service.get_runtime_status().is_executing
            commands = [call.args[0] for call in carmaker.execute_command.call_args_list]
            assert not any('SC.TAccel 1.0' in cmd or 'DM.Gas 1' in cmd for cmd in commands)
            assert any(event['type'] == 'error' for event in client.get('/api/triggers/events').json())
            # Fresh intent after cancellation drains has a fresh token and no old jobs.
            assert client.post('/api/triggers/monitoring', json={'active': True}).status_code == 200
            assert service.get_runtime_status().queued_count == 0
            service.set_monitoring_state(False)
    finally:
        release.set()
        service.set_monitoring_state(False)
        if worker is not None:
            worker.join(3)
        extra_worker = service._worker_thread
        if extra_worker is not None:
            extra_worker.join(3)
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)


@pytest.mark.parametrize('failure', ['DVA', 'wait', 'telemetry'])
def test_backend_sequence_aborts_on_first_failure(failure):
    carmaker = Mock()
    actions = ActionService(carmaker)
    if failure == 'DVA':
        carmaker.execute_command.side_effect = RuntimeError('DVA failed')
        text = 'DM.Brake = 1 | 1000 | Abs\nDM.Gas = 1 | 1000 | Abs'
    elif failure == 'wait':
        carmaker.get_telemetry.return_value = build_telemetry({'Car.v': 10})
        text = 'wait_until Car.v < 1 1\nDM.Gas = 1 | 1000 | Abs'
    else:
        carmaker.get_telemetry.side_effect = RuntimeError('telemetry failed')
        text = 'wait_until Car.v < 1 100\nDM.Gas = 1 | 1000 | Abs'
    with pytest.raises(RuntimeError):
        actions.execute_command_sequence(text)
    assert not any('DM.Gas' in call.args[0] for call in carmaker.execute_command.call_args_list)


def test_reset_does_not_release_controls_without_confirmed_stop():
    carmaker = carmaker_mock()
    carmaker.execute_command.side_effect = RuntimeError('StopSim unconfirmed')
    with pytest.raises(RuntimeError, match='StopSim'):
        ActionService(carmaker).reset_controls()
    assert [call.args[0] for call in carmaker.execute_command.call_args_list] == ['StopSim']


def test_late_telemetry_cannot_satisfy_an_expired_wait(monkeypatch):
    carmaker = Mock()
    clock = [0.0]
    monkeypatch.setattr('app.services.action_service.time.monotonic', lambda: clock[0])
    def delayed_sample():
        clock[0] = .01
        return build_telemetry({'Car.v': 0})
    carmaker.get_telemetry.side_effect = delayed_sample
    actions = ActionService(carmaker)
    sequence = 'wait_until Car.v < 1 1\nDM.Gas = 1 | 1000 | Abs'
    with pytest.raises(RuntimeError, match='Timeout'):
        actions.execute_command_sequence(sequence)
    carmaker.execute_command.assert_not_called()


def test_stale_sampling_generation_cannot_enqueue_after_stop_restart(tmp_path, monkeypatch):
    carmaker = Mock()
    service = TriggerService(tmp_path / 'triggers.json', carmaker, Mock())
    monkeypatch.setattr(service, '_ensure_monitor_thread', lambda: None)
    monkeypatch.setattr(service, '_ensure_worker_thread', lambda: None)
    service.create_trigger(CreateTriggerRequest(name='old', expression='Car.v > 0', message='test'))
    service.set_monitoring_state(True)
    def old_sample():
        service.set_monitoring_state(False)
        service.set_monitoring_state(True)
        return build_telemetry({'Car.v': 10})
    carmaker.get_telemetry.side_effect = old_sample
    service._tick_monitoring()
    assert service.get_runtime_status().queued_count == 0
    service.set_monitoring_state(False)


def test_normal_trigger_success_preserves_monitoring_intent_and_runs_action():
    carmaker = Mock()
    state_changes, events = Mock(), []
    executor = TriggerExecutor(carmaker, ActionService(carmaker),
                               Mock(generate_trigger_response=AsyncMock(return_value='DM.Brake = 1 | 1000 | Abs')))
    executor.execute(trigger(), {'Car.v': 10}, threading.Event(), lambda: True,
                     state_changes, Mock(), events.append)
    commands = [call.args[0] for call in carmaker.execute_command.call_args_list]
    assert commands == ['DVAWrite SC.TAccel 0.0001 30000 Abs',
                        'DVAWrite SC.TAccel 1.0 30000 Abs', 'DVAWrite DM.Brake 1.0 1000 Abs']
    state_changes.assert_not_called()
    assert not any(event.type == 'error' for event in events)


def test_failed_stop_is_in_error_event_and_no_resume_occurs():
    carmaker = carmaker_mock()
    carmaker.execute_command.side_effect = RuntimeError('transport disconnected')
    events = []
    executor = TriggerExecutor(carmaker, ActionService(carmaker), Mock())
    executor.execute(trigger(), {}, threading.Event(), lambda: True, Mock(), Mock(), events.append)
    assert 'StopSim unconfirmed' in events[-1].content
    assert not any('SC.TAccel 1.0' in call.args[0] for call in carmaker.execute_command.call_args_list)


def test_sampling_failure_stops_runtime_and_reports_unconfirmed_stop(tmp_path):
    carmaker = Mock()
    carmaker.get_telemetry.side_effect = RuntimeError('telemetry offline')
    carmaker.execute_command.side_effect = RuntimeError('socket closed')
    service = TriggerService(tmp_path / 'triggers.json', carmaker, Mock())
    service._monitoring_active = True
    service._monitor_loop()
    assert not service.is_monitoring_active()
    assert 'StopSim unconfirmed' in service.get_events()[-1].content


def test_late_sampling_failure_cannot_stop_restarted_monitoring(tmp_path, monkeypatch):
    entered, release, fresh_sample = threading.Event(), threading.Event(), threading.Event()
    carmaker = Mock()
    carmaker.is_monitoring_active.return_value = True
    service = TriggerService(tmp_path / 'triggers.json', carmaker, Mock())
    monkeypatch.setattr(service, '_ensure_monitor_thread', lambda: None)
    monkeypatch.setattr(service, '_ensure_worker_thread', lambda: None)
    reads = 0

    def sample():
        nonlocal reads
        reads += 1
        if reads == 1:
            entered.set()
            assert release.wait(3)
            raise RuntimeError('old connection timed out')
        fresh_sample.set()
        return build_telemetry({'Car.v': 0})

    carmaker.get_telemetry.side_effect = sample
    service.set_monitoring_state(True)
    worker = threading.Thread(target=service._monitor_loop)
    worker.start()
    try:
        assert entered.wait(2)
        service.set_monitoring_state(False)
        service.set_monitoring_state(True)
        release.set()
        assert fresh_sample.wait(2), 'old sampling failure stopped the new monitoring session'
        assert service.is_monitoring_active()
        carmaker.execute_command.assert_not_called()
        assert service.get_events() == []
    finally:
        release.set()
        service.set_monitoring_state(False)
        worker.join(3)
        assert not worker.is_alive()


def test_reconnect_cannot_split_confirmed_stop_and_control_release(monkeypatch):
    service = CarMakerService()
    old_client = Mock(connected=True)
    new_client = Mock(connected=True)
    service._state.client = old_client
    monkeypatch.setattr('app.services.carmaker.CarMakerClient', lambda **kwargs: new_client)
    stopped, release, reconnecting, reconnected = (threading.Event() for _ in range(4))
    send = service.execute_command
    errors = []

    def pause_after_stop(command):
        result = send(command)
        if command == 'StopSim':
            stopped.set()
            assert release.wait(3)
        return result

    monkeypatch.setattr(service, 'execute_command', pause_after_stop)

    def reset():
        try:
            assert ActionService(service).reset_controls() == (5, 5)
        except Exception as exc:
            errors.append(exc)

    def reconnect():
        reconnecting.set()
        service.connect('fake-host', 16660)
        reconnected.set()

    resetting = threading.Thread(target=reset)
    connecting = threading.Thread(target=reconnect)
    resetting.start()
    try:
        assert stopped.wait(2)
        connecting.start()
        assert reconnecting.wait(2)
        assert not reconnected.wait(.1), 'reconnect split StopSim from its control release'
    finally:
        release.set()
        resetting.join(3)
        if connecting.ident is not None:
            connecting.join(3)
        assert not resetting.is_alive() and not connecting.is_alive()
    assert errors == []
    assert reconnected.is_set()
    assert old_client.execute_command.call_count == 6
    new_client.execute_command.assert_not_called()
