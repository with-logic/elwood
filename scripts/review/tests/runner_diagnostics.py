"""Retain bounded attempt failures only in the copied, fake-CLI test runner (PRD §16)."""


def install_attempt_diagnostics(root):
    runtime = root / 'scripts/review/runtime.sh'
    source = runtime.read_text().replace('run_capped() {', 'run_capped_without_capture() {', 1)
    runtime.write_text(source + r'''
run_capped() {
  local diagnostic code=0
  diagnostic=$(mktemp "$root/capped-attempt.XXXXXX")
  run_capped_without_capture "$@" 2>"$diagnostic" || code=$?
  cat "$diagnostic" >&2
  if [ "$code" -ne 0 ]; then
    { printf 'lens=%s attempt=%s exit=%s\n' "${lens:-synthesis}" "${attempt:-1}" "$code"
      head -c 2048 "$diagnostic"
    } > "$diagnostic.failure"
  fi
  rm -f "$diagnostic"
  return "$code"
}
''')


def attempt_diagnostics(root):
    reports = [path.read_text(errors='replace') for path in sorted(root.glob('capped-attempt.*.failure'))]
    return '\nFixture attempt diagnostics (bounded):\n' + '\n'.join(reports)[:4096]


def assert_one_attempt(test, root, result):
    test.assertEqual((root / 'call-review-architecture-conventions').read_text(),
                     '1', result.stderr + attempt_diagnostics(root))
