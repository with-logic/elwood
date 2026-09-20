"""Deterministic OpenCode substitute for real runner-process tests."""
STUB = r'''#!/usr/bin/env python3
import atexit, io, json, os, pathlib, re, signal, subprocess, sys, time
original_stdout = sys.stdout
sys.stdout = io.StringIO()
def emit_events():
    text = sys.stdout.getvalue()
    sys.stdout = original_stdout
    def event(kind, message, **part):
        print(json.dumps({'type': kind, 'part': {'messageID': message, **part}}))
    event('step_start', 'progress')
    event('text', 'progress', text='Inspecting the code first.')
    event('tool_use', 'progress', state={'output': 'PRIVATE TOOL OUTPUT'})
    event('step_finish', 'progress', reason='tool-calls')
    event('step_start', 'answer')
    event('text', 'answer', text=text)
    event('step_finish', 'answer', reason='stop')
atexit.register(emit_events)
root = pathlib.Path(os.environ['REVIEW_TEST_ROOT'])
prompt = sys.argv[sys.argv.index('--variant') + 2]
match = re.search(r'using the /(review-[a-z0-9-]+) skill', prompt)
name = match[1] if match else 'synthesis'
marker = root / ('call-' + name)
count = int(marker.read_text()) + 1 if marker.exists() else 1
marker.write_text(str(count))
mode = os.environ.get('REVIEW_TEST_MODE', 'clean')
assert '--auto' not in sys.argv
assert '-f' not in sys.argv
evidence = sys.stdin.read()
assert sys.argv[sys.argv.index('--format') + 1] == 'json'
policy = json.loads(os.environ['OPENCODE_CONFIG_CONTENT'])['agent']['elwood-review']['permission']
assert policy['*'] == 'deny' and policy['bash'] == 'deny'
assert policy['read']['*.env'] == 'deny'
assert {key for key, value in policy.items() if value == 'allow'} == {'glob'}
assert policy['grep'] == 'deny' and policy['skill'] == 'deny'
assert policy['read'] == {'*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow'}
assert all(policy[key] == 'deny' for key in ['bash', 'webfetch', 'websearch', 'external_directory', 'lsp', 'grep', 'skill'])
context = root / 'scripts/review/discussion.txt'
if context.exists():
    assert context.read_text() in evidence, 'PR context was not fully supplied to this model call'
    assert 'TRUSTED_PR_CONTEXT' in evidence

if match:
    assert '\n--- BEGIN review.diff ---\n' in evidence
    assert '+bounded fixture diff' in evidence
    if mode == 'large-input':
        assert 'DIFF_LAST_CANARY' in evidence and 'CONTEXT_LAST_CANARY' in evidence
    assert 'static review only' in prompt
    if mode == 'killed' and name == 'review-architecture-conventions':
        os.kill(os.getpid(), signal.SIGKILL)
    if mode == 'all-failed' or (mode == 'missing' and name == 'review-architecture-conventions'):
        print('PRIVATE-REVIEW-TEXT', file=sys.stderr)
        sys.exit(1)
    if mode == 'first-error-timeout' and name == 'review-architecture-conventions' and count == 1:
        diagnostic_message = 'FIRST_ATTEMPT_CANARY' + 'x' * 5000 + 'TRUNCATED_TAIL_CANARY'
        raise RuntimeError(diagnostic_message)
    if mode in ['timeout', 'first-error-timeout'] and name == 'review-architecture-conventions':
        subprocess.Popen([sys.executable, '-c',
            'import pathlib,time; time.sleep(6); pathlib.Path(' + repr(str(root / 'orphan')) + ').touch()'])
        time.sleep(20)
    if mode == 'retry' and count == 1:
        sys.exit(1)
    if mode == 'malformed' and name == 'review-security':
        print('The lens stopped before finishing.')
    elif mode in ['finding', 'oversize', 'aggregate', 'large-input'] and (mode == 'aggregate' or name == 'review-security'):
        if mode in ['oversize', 'aggregate']: print('X' * (70000 if mode == 'oversize' else 30000))
        if mode == 'large-input': print('P' * 60000 + 'REPORT_LAST_CANARY')
        print('#### major: Propagated finding\n- Confidence: high\n- Location: fixture:1\n- Finding: It fails.\n- If unfixed: Failure persists.\n- Fix: Fix it.\n- Fix cost: One line.')
    else:
        print('No findings.')
    (root / ('done-' + name)).touch()
else:
    if mode == 'synth-timeout':
        time.sleep(20)
    if mode == 'synth-killed':
        os.kill(os.getpid(), signal.SIGKILL)
    if mode == 'synth-failed':
        print('PRIVATE-SYNTHESIS-TEXT', file=sys.stderr)
        sys.exit(2)
    entries = re.findall(r'\n--- BEGIN (review-[a-z-]+\.md) ---\n(.*?)\n--- END \1 ---\n', evidence, re.S)
    assert entries
    if mode in ['clean', 'finding', 'retry', 'large-input']: assert len(entries) == 11
    if mode == 'large-input':
        assert 'REPORT_LAST_CANARY' in evidence and 'CONTEXT_LAST_CANARY' in evidence
    reports = {}
    for filename, report in entries:
        name = pathlib.Path(filename).stem
        assert (root / ('done-' + name)).exists(), 'Synthesis ran before lens finished'
        reports[name] = report
    print('# Review')
    if mode != 'no-verdict':
        print('Verdict: not ready - 0 blocker(s), 1 major(s), 0 minor(s), 0 nit(s)'
              if mode in ['finding', 'large-input'] else 'Verdict: clean, no notes')
    print('\n## Findings By Dimension')
    for name, report in reports.items():
        print('\n### ' + name + '\n\n' + report)
    print('\n## Reviewer Coverage')
    for name in reports:
        print('- ' + name + ': completed')
'''
