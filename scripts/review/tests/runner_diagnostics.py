"""Retain bounded attempt failures only in the copied, fake-CLI test runner (PRD §16)."""
from pathlib import Path
import shutil


def install_attempt_diagnostics(root):
    shutil.copy(Path(__file__).with_name('runner_attempt_capture.py'), root / 'retain-attempt.py')
    runtime = root / 'scripts/review/runtime.sh'
    source = runtime.read_text().replace('cleanup() {', 'cleanup_without_capture() {', 1)
    runtime.write_text(source + r'''
exec 4>&2
cleanup() {
  local code=$? failure
  if [ -f "$tmp/synth.validation.err" ]; then cat "$tmp/synth.validation.err" >&4; fi
  if [ "$code" -ne 0 ] && [ -f "$tmp/synth.err" ]; then
    failure=$code
    if [ "${synth_code:-0}" -ne 0 ]; then failure=$synth_code; fi
    python3 "$root/retain-attempt.py" "$root" synthesis 1 "$failure" "$tmp/synth.err" "$tmp/synth.validation.err"
  fi
  cleanup_without_capture
}
''')
    runner = root / 'scripts/review/run.sh'
    source = runner.read_text().replace('run_lens_once() {', 'run_lens_without_capture() {', 1)
    wrapper = r'''
run_lens_once() {
  local code=0 diagnostic
  diagnostic=$(mktemp "$tmp/attempt.stderr.XXXXXX")
  run_lens_without_capture "$@" 2>"$diagnostic" || code=$?
  cat "$diagnostic" >&2
  python3 "$root/retain-attempt.py" "$root" "$1" "$attempt" "$code" "$tmp/$1.err" "$diagnostic"
  rm -f "$diagnostic"
  return "$code"
}
'''
    source = source.replace('. "$root/scripts/review/retry.sh"', wrapper + '\n. "$root/scripts/review/retry.sh"')
    source = source.replace('synth_code=0', ': > "$tmp/synth.validation.err"\nsynth_code=0', 1)
    source = source.replace('. "$root/scripts/review/validate.sh"', '. "$root/scripts/review/validate.sh" 2>"$tmp/synth.validation.err"')
    runner.write_text(source)


def attempt_diagnostics(root):
    reports = [path.read_text(errors='replace') for path in sorted(root.glob('capped-attempt.*.failure'))]
    return '\nFixture attempt diagnostics (bounded):\n' + '\n'.join(reports)[:4096]


def assert_architecture_lens_one_attempt(test, root, result):
    test.assertEqual((root / 'call-review-architecture-conventions').read_text(),
                     '1', result.stderr + attempt_diagnostics(root))
