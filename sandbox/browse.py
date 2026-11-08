"""The browser tool for a shell inside the container: one JSON argument in, one JSON result out.
python3 /opt/aeeis/browse.py '{"url": "http://127.0.0.1:3000/", "steps": [{"action": "click", "selector": "button"}]}'"""
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location('runner', '/opt/aeeis/runner.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
try:
    print(json.dumps(runner.browse(json.loads(sys.argv[1]), 60), ensure_ascii=False))
except runner.ToolError as error:
    print(json.dumps({'error': str(error), 'details': error.details}, ensure_ascii=False))
    sys.exit(1)
