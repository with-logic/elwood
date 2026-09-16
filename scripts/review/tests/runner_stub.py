"""Deterministic OpenCode substitute for real runner-process tests."""
STUB = r'''#!/usr/bin/env python3
import json, os, pathlib, re, subprocess, sys, time
root = pathlib.Path(os.environ['REVIEW_TEST_ROOT'])
prompt = sys.argv[sys.argv.index('--variant') + 2]
match = re.search(r'using the /(review-[a-z0-9-]+) skill', prompt)
name = match[1] if match else 'synthesis'
marker = root / ('call-' + name)
count = int(marker.read_text()) + 1 if marker.exists() else 1
marker.write_text(str(count))
mode = os.environ.get('REVIEW_TEST_MODE', 'clean')
assert '--auto' not in sys.argv
policy = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])['agent']['elwood-review']['permission']
assert policy['*'] == 'deny' and policy['bash'] == 'deny'
assert policy['read']['*.env'] == 'deny'
assert {key for key, value in policy.items() if value == 'allow'} == {'glob'}
assert policy['grep'] == 'deny' and policy['skill'] == 'deny'
assert set(policy['read']) == {'*', '*.env', '*.env.*', '*.env.example'}

if match:
    attachment = pathlib.Path(sys.argv[sys.argv.index('-f') + 1])
    assert attachment.name == 'review.diff' and attachment.exists()
    assert '+bounded fixture diff' in attachment.read_text()
    assert 'static review only' in prompt
    if mode == 'all-failed' or (mode == 'missing' and name == 'review-architecture-conventions'):
        print('PRIVATE-REVIEW-TEXT', file=sys.stderr)
        sys.exit(1)
    if mode == 'timeout' and name == 'review-architecture-conventions':
        subprocess.Popen([sys.executable, '-c',
            'import pathlib,time; time.sleep(6); pathlib.Path(' + repr(str(root / 'orphan')) + ').touch()'])
        time.sleep(20)
    if mode == 'retry' and count == 1:
        sys.exit(1)
    if mode == 'malformed' and name == 'review-security':
        print('The lens stopped before finishing.')
    elif mode in ['finding', 'oversize', 'aggregate'] and (mode == 'aggregate' or name == 'review-security'):
        if mode in ['oversize', 'aggregate']: print('X' * (70000 if mode == 'oversize' else 30000))
        print('#### major: Propagated finding\n- Confidence: high\n- Location: fixture:1\n- Finding: It fails.\n- If unfixed: Failure persists.\n- Fix: Fix it.\n- Fix cost: One line.')
    else:
        print('No findings.')
    (root / ('done-' + name)).touch()
else:
    if mode == 'synth-failed':
        print('PRIVATE-SYNTHESIS-TEXT', file=sys.stderr)
        sys.exit(2)
    attachments = [pathlib.Path(sys.argv[i + 1]) for i, arg in enumerate(sys.argv) if arg == '-f']
    assert attachments
    if mode in ['clean', 'finding', 'retry']: assert len(attachments) == 11
    reports = {}
    for path in attachments:
        assert (root / ('done-' + path.stem)).exists(), 'Synthesis ran before lens finished'
        reports[path.stem] = path.read_text()
    print('# Review')
    if mode != 'no-verdict':
        print('Verdict: not ready - 0 blocker(s), 1 major(s), 0 minor(s), 0 nit(s)'
              if mode == 'finding' else 'Verdict: clean, no notes')
    print('\n## Findings By Dimension')
    for name, report in reports.items():
        print('\n### ' + name + '\n\n' + report)
    print('\n## Reviewer Coverage')
    for name in reports:
        print('- ' + name + ': completed')
'''
