import Foundation
@main struct Validation {
 static func main() throws {
  var c = FluxSettings()
  try c.validate()
  do { _ = try c.toggled(); fatalError("cannot enable unconfigured quick toggle") } catch {}
  c.enabled = true
  for bad in ["", "http://docs.yandex.ru/a", "https://docs.yandex.ru.attacker.test/a", "https://user:secret@docs.yandex.ru/a", "https://docs.yandex.ru:8443/a", "https://127.0.0.1/a"] {
   c.document = bad
   do { try c.validate(); fatalError("unsafe document accepted") } catch {}
  }
  c.document="https://docs.yandex.ru/docs/view?url=example"
  try c.validate()
  let disabled = try c.toggled()
  precondition(!disabled.enabled && disabled.document == c.document && disabled.transport == c.transport)
  let restored = try disabled.toggled()
  precondition(restored == c)
  c.transport="oneme"
  do {try c.validate();fatalError("unfinished transport accepted")} catch {}
  let safelyDisabled = try c.toggled()
  precondition(!safelyDisabled.enabled, "Quick toggle can disable unsupported stored transport")
  print("PASS: OpenFlux document validation and disabled/unsupported transport boundaries")
 }
}
