#!/usr/bin/env python3
"""Typecheck documentation snippets against the adjacent library, without launching an agent."""
from pathlib import Path
import json
import html
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
library = root.parent
with tempfile.TemporaryDirectory(prefix='elwood-doc-types-') as temporary:
    folder = Path(temporary)
    count = 0
    for path in sorted((root / 'docs/guide').glob('*.md')):
        for index, code in enumerate(re.findall(r'```ts\n([\s\S]*?)\n```', path.read_text())):
            prelude = ''
            if not re.search(r'import[\s\S]*?\bClaudeSession\b[^;]*;', code):
                prelude += 'import { ClaudeSession } from "@with-logic/elwood";\n'
            if re.search(r'\bsession\b', code) and not re.search(r'const session\s*=', code):
                prelude += 'const session = new ClaudeSession();\n'
            (folder / f'{path.stem}-{index}.mts').write_text(prelude + code)
            count += 1
    landing = re.search(r'<pre><code>([\s\S]*?)</code>', (root / 'index.html').read_text()).group(1)
    (folder / 'landing.mts').write_text(html.unescape(re.sub(r'<[^>]+>', '', landing)))
    demo_codes = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', 'import { CHAPTERS } from "./terminal-demo.mjs"; console.log(JSON.stringify(CHAPTERS.flatMap(chapter => chapter.steps).filter(step => step.text.startsWith("import {")).map(step => step.text)));'], cwd=root))
    for index, code in enumerate(demo_codes):
        (folder / f'walkthrough-{index}.mts').write_text(code)
    count += 1 + len(demo_codes)
    config = {'compilerOptions': {'target': 'ESNext', 'lib': ['ESNext'], 'module': 'NodeNext', 'moduleResolution': 'NodeNext', 'strict': True, 'noEmit': True, 'allowImportingTsExtensions': True, 'skipLibCheck': True, 'types': ['node'], 'typeRoots': [str(library / 'node_modules/@types')], 'paths': {'@with-logic/elwood': [str(library / 'src/index.ts')]}}, 'include': [str(folder / '*.mts')]}
    (folder / 'tsconfig.json').write_text(json.dumps(config))
    subprocess.run([str(library / 'node_modules/.bin/tsc'), '-p', str(folder / 'tsconfig.json')], check=True)
    print(f'Typechecked {count} TypeScript examples against the library without running them.')
