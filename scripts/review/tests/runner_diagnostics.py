"""Retain bounded attempt failures only in the copied, fake-CLI test runner (PRD §16)."""
from pathlib import Path
import shutil
from runner_attempt_capture import MAX_ATTEMPT_STDERR_BYTES

MAX_DIAGNOSTIC_CHARS = 4096
DIAGNOSTIC_PREFIX = "\nFixture attempt diagnostics (bounded):\n"


def install_attempt_diagnostics(root):
    shutil.copy(Path(__file__).with_name('runner_attempt_capture.py'), root / 'retain-attempt.py')
    runtime = root / 'scripts/review/runtime.sh'
    source = runtime.read_text().replace('cleanup() {', 'cleanup_without_capture() {', 1)
    runtime.write_text(source + r'''
cleanup() {
  local code=$? failure
  if [ -f "$tmp/synth.validation.err" ]; then head -c ATTEMPT_STDERR_BYTES "$tmp/synth.validation.err" >&4 || true; fi
  if [ "$code" -ne 0 ] && [ "${synthesis_active:-false}" = true ]; then
    failure=$code
    if [ "${synth_code:-0}" -ne 0 ]; then failure=$synth_code; fi
    python3 "$root/retain-attempt.py" "$root" synthesis 1 "$failure" "$tmp/synth.err" "$tmp/synth.validation.err" || true
  fi
  cleanup_without_capture
}
# The original EXIT trap is already armed: install its handler before touching fds.
exec 4>&2 || exec 4>/dev/null
'''.replace('ATTEMPT_STDERR_BYTES', str(MAX_ATTEMPT_STDERR_BYTES)))
    runner = root / 'scripts/review/run.sh'
    source = runner.read_text().replace('run_lens_once() {', 'run_lens_without_capture() {', 1)
    source = source.replace('"$tmp/$lens.err"', '"$process_stderr"')
    source = source.replace('rm -f "$root/REVIEW.md"',
                            'rm -f "$root/REVIEW.md" "$root"/capped-attempt.*.failure', 1)
    wrapper = r'''
run_lens_once() {
  local code=0 diagnostic process_stderr
  diagnostic=$(mktemp "$tmp/attempt.stderr.XXXXXX")
  process_stderr=$(mktemp "$tmp/attempt.process.stderr.XXXXXX")
  run_lens_without_capture "$@" 2>"$diagnostic" || code=$?
  cat "$diagnostic" >&2 || true
  if [ "$code" -ne 0 ]; then
    python3 "$root/retain-attempt.py" "$root" "$1" "$attempt" "$code" "$process_stderr" "$diagnostic" || true
  fi
  rm -f "$diagnostic" "$process_stderr"
  return "$code"
}
'''
    source = source.replace('. "$root/scripts/review/retry.sh"', wrapper + '\n. "$root/scripts/review/retry.sh"')
    source = source.replace('synth_code=0', 'synthesis_active=true\n: > "$tmp/synth.validation.err"\nsynth_code=0', 1)
    source = source.replace('. "$root/scripts/review/validate.sh"', '. "$root/scripts/review/validate.sh" 2>"$tmp/synth.validation.err"')
    source = source.replace('. "$root/scripts/review/assemble.sh"', 'synthesis_active=false\n. "$root/scripts/review/assemble.sh"')
    runner.write_text(source)


def attempt_diagnostics(root):
    chunks = []
    remaining = MAX_DIAGNOSTIC_CHARS
    for path in sorted(root.glob('capped-attempt.*.failure')):
        if remaining == 0:
            break
        separator = '\n' if chunks else ''
        remaining -= len(separator)
        with path.open(errors='replace') as report:
            chunk = report.read(remaining)
        chunks.append(separator + chunk)
        remaining -= len(chunk)
    return DIAGNOSTIC_PREFIX + ''.join(chunks)


def assert_architecture_lens_one_attempt(test, root, result):
    test.assertEqual((root / 'call-review-architecture-conventions').read_text(),
                     '1', result.stderr + attempt_diagnostics(root))
