import Foundation
import CryptoKit

@main struct Check {
    static func rejects(_ payload: String, nonce: String = "N", key: String = "K") {
        precondition((try? SignedActionPayload.parse(payload, nonce: nonce, expectedKey: key)) == nil, "Expected rejection: \(payload)")
    }
    static func main() throws {
        let valid = #"{"action":"order_taxi","amount_rub":450,"expires_at":1789627818,"issued_at":1789627698,"key_id":"K","kind":"paid_action","max_final_rub":517,"nonce":"N","params":{"from":"ул. \"Красная\", 1","tariff":"econom","to":"Аэропорт"},"service":"yandex_go","v":1}"#
        let parsed = try SignedActionPayload.parse(valid, nonce: "N", expectedKey: "K")
        precondition(parsed.amountRub == 450 && parsed.maxFinalRub == 517 && parsed.expiresAt == 1789627818)
        precondition(parsed.rows.map(\.label) == ["Откуда", "Куда", "Тариф"] && parsed.rows[0].value == "ул. \"Красная\", 1")
        precondition(parsed.title == "Заказ такси · Яндекс Go")
        rejects(valid, nonce: "other")
        rejects(valid, key: "other")
        rejects(valid.replacingOccurrences(of: ",", with: ", "))
        rejects(valid.replacingOccurrences(of: #""amount_rub":450"#, with: #""amount_rub":450.0"#))
        rejects(valid.replacingOccurrences(of: #""amount_rub":450"#, with: #""amount_rub":true"#))
        rejects(valid.replacingOccurrences(of: #""amount_rub":450,"#, with: #""amount_rub":450,"amount_rub":45,"#))
        rejects(valid.replacingOccurrences(of: #""action":"order_taxi","#, with: #""action":"order_taxi","hidden":1,"#))
        rejects(valid.replacingOccurrences(of: #""max_final_rub":517"#, with: #""max_final_rub":449"#))
        rejects(valid.replacingOccurrences(of: #""expires_at":1789627818"#, with: #""expires_at":1789628818"#))
        rejects(valid.replacingOccurrences(of: #""tariff":"econom""#, with: #""tariff":{"a":"b"}"#))
        rejects(valid.replacingOccurrences(of: #""v":1"#, with: #""v":2"#))
        let tricky = "a\"\\\n" + String(UnicodeScalar(1)) + String(UnicodeScalar(0x1F)) + "ё/😀"
        precondition(SignedCanonicalJSON.string(tricky) == #""a\"\\\n\u0001\u001fё/😀""#)
        // JavaScript сортирует ключи по UTF-16: "😀" (D83D) раньше "ｚ" (FF5A), хотя по скалярам наоборот.
        let sorted = try SignedCanonicalJSON.encode(["ｚ": 1, "😀": 2, "B": 3, "a": NSNull()] as [String: Any])
        precondition(sorted == #"{"B":3,"a":null,"😀":2,"ｚ":1}"#, sorted)
        // Формат ключа и подписи тот же, что у Secure Enclave API; сервер проверяет их в run.py.
        let key = P256.Signing.PrivateKey()
        let signature = try key.signature(for: Data(valid.utf8)).rawRepresentation
        precondition(signature.count == 64)
        let out: [String: String] = ["spki": key.publicKey.derRepresentation.base64EncodedString(), "payload": valid, "signature": signature.base64EncodedString()]
        print(String(data: try JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
    }
}
