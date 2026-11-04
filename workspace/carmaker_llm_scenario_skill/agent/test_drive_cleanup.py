import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from carmaker_drive_loop import DriveLoopConfig, TriggerPolicy, run_triggered_drive


class DriveCleanupTests(unittest.TestCase):
    def test_failure_after_start_always_attempts_stop_and_preserves_error(self):
        class Client:
            def __init__(self):
                self.commands = []
            def command(self, command):
                self.commands.append(command)
                if command == 'StopSim' and 'StartSim' in self.commands:
                    raise RuntimeError('stop unconfirmed')
                return 'O'
        client = Client()
        with tempfile.TemporaryDirectory() as tmp:
            config = DriveLoopConfig('fake', ['Time'], [TriggerPolicy('p', 'Time > 0', [])],
                                     Path(tmp), .01, .02, .0001, 30000, 1000, verbose=False)
            with patch('carmaker_drive_loop.wait_for_fresh_sim_time', side_effect=RuntimeError('telemetry failed')):
                with self.assertRaisesRegex(RuntimeError, 'telemetry failed'):
                    run_triggered_drive(client, config)
            self.assertEqual(client.commands[-1], 'StopSim')
            self.assertIn('stop unconfirmed', (Path(tmp) / 'summary.md').read_text())

    def test_start_policy_action_final_and_stop_failure_paths(self):
        for stage in ['start', 'policy', 'action', 'final', 'stop', 'interrupt', 'normal', 'keep_running']:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as tmp:
                class Client:
                    def __init__(self):
                        self.commands = []
                    def command(self, command):
                        self.commands.append(command)
                        if stage == 'start' and command == 'StartSim':
                            raise RuntimeError('start unconfirmed')
                        if stage == 'action' and command.startswith('DVAWrite DM.Gas'):
                            raise RuntimeError('action failed')
                        if stage == 'final' and command.startswith('DVARead'):
                            raise RuntimeError('final telemetry failed')
                        if stage == 'stop' and command == 'StopSim' and 'StartSim' in self.commands:
                            raise RuntimeError('stop unconfirmed')
                        if command.startswith('DVARead'):
                            return 'O' + ' '.join('1' for _ in command.split()[1:])
                        return 'O'
                client = Client()
                config = DriveLoopConfig('fake', ['Time'], [TriggerPolicy('p', 'Time > 0', ['gas 1'])],
                                         Path(tmp), .01, 1 if stage in ['policy', 'action'] else 0,
                                         .0001, 30000, 1000, stop_at_end=stage != 'keep_running', verbose=False)
                with patch('carmaker_drive_loop.wait_for_fresh_sim_time',
                           side_effect=KeyboardInterrupt() if stage == 'interrupt' else None), \
                     patch('carmaker_drive_loop.time.sleep'), \
                     patch('carmaker_drive_loop.evaluate_expression',
                           side_effect=RuntimeError('policy failed') if stage == 'policy' else None,
                           return_value=True):
                    if stage in ['normal', 'keep_running']:
                        run_triggered_drive(client, config)
                    else:
                        with self.assertRaises(KeyboardInterrupt if stage == 'interrupt' else RuntimeError):
                            run_triggered_drive(client, config)
                expected_stops = 1 if stage == 'keep_running' else 2
                self.assertEqual(client.commands.count('StopSim'), expected_stops)
                self.assertTrue((Path(tmp) / 'summary.md').exists())
