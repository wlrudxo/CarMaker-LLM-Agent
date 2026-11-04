import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from carmaker_research_runner import main, preflight_command


class DemoPreflightTests(unittest.TestCase):
    def test_explicit_profile_paths_are_checked_without_network_or_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bin').mkdir()
            (root / 'bin/CarMaker.win64.exe').write_bytes(b'synthetic executable; never run')
            (root / 'project/Data/TestRun').mkdir(parents=True)
            (root / 'project/Data/TestRun/demo').write_text('synthetic TestRun')
            args = SimpleNamespace(backend_url='http://127.0.0.1:18000', project_dir=str(root / 'project'),
                                   carmaker_root=str(root), testrun='demo')
            output = io.StringIO()
            with patch('socket.socket', side_effect=AssertionError('network forbidden')), \
                 patch('urllib.request.urlopen', side_effect=AssertionError('HTTP forbidden')), \
                 patch('carmaker_research_runner.create_command_client', side_effect=AssertionError('commands forbidden')), \
                 patch('sys.argv', ['runner', 'preflight', '--backend-url', args.backend_url,
                                    '--project-dir', args.project_dir, '--carmaker-root', args.carmaker_root,
                                    '--testrun', args.testrun]), \
                 redirect_stdout(output):
                self.assertEqual(main(), 0)
            result = json.loads(output.getvalue())
            self.assertFalse(result['connectionChecked'])
            self.assertEqual(result['backendUrl'], args.backend_url)
            for field, invalid in [('backend_url', 'http://127.0.0.1'), ('backend_url', 'http://127.0.0.1:8000/api'),
                                   ('backend_url', 'http://user:secret@localhost:8000'),
                                   ('project_dir', str(root / 'missing')), ('carmaker_root', str(root / 'missing')),
                                   ('testrun', '../outside'), ('testrun', 'missing'), ('testrun', 'demo\nStartSim')]:
                original = getattr(args, field)
                setattr(args, field, invalid)
                with self.subTest(field=field, value=invalid), self.assertRaises((RuntimeError, ValueError)):
                    preflight_command(args)
                setattr(args, field, original)
