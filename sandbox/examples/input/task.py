import json
import subprocess
from pathlib import Path

numbers = json.loads(Path('/input/numbers.json').read_text())
answer = {'count': len(numbers), 'sum': sum(numbers),
          'node': subprocess.check_output(['node', '--version'], text=True).strip()}
Path('/work/result.json').write_text(json.dumps(answer, indent=2) + '\n')
print(json.dumps(answer))
