import SwiftUI
import CryptoKit
import LocalAuthentication

/// Платное действие, которое сервер просит подписать. Спецификация — docs/signed-actions.md.
/// Карточка строится из тех же байтов, что подписываются, а байты должны быть
/// каноническими: иначе сервер мог бы показать одно, а подписать дать другое
/// (дубликаты ключей, скрытые поля, дробные числа).
struct SignedActionPayload: Equatable {
    let nonce: String
    let keyId: String
    let service: String
    let action: String
    let params: [String: String]
    let amountRub: Int
    let maxFinalRub: Int
    let issuedAt: Int
    let expiresAt: Int

    static let fields: Set<String> = ["v", "kind", "service", "action", "params", "amount_rub", "max_final_rub", "nonce", "key_id", "issued_at", "expires_at"]

    /// `expectedKey` — ключ, лежащий на этом iPhone. Подписывать чужой key_id бессмысленно и подозрительно.
    static func parse(_ payload: String, nonce: String, expectedKey: String) throws -> SignedActionPayload {
        let bytes = Data(payload.utf8)
        guard bytes.count <= 4_096, let root = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              (try? SignedCanonicalJSON.encode(root)) == payload else { throw AgentError.message("Сервер прислал действие в неканоническом виде. Подписывать нельзя.") }
        guard Set(root.keys) == fields, root["v"] as? Int == 1, root["kind"] as? String == "paid_action" else { throw AgentError.message("Неизвестный формат платного действия") }
        guard root["nonce"] as? String == nonce else { throw AgentError.message("Действие не совпадает с запросом") }
        guard root["key_id"] as? String == expectedKey else { throw AgentError.message("Действие выписано на другой ключ подписи") }
        guard let service = root["service"] as? String, let action = root["action"] as? String,
              [service, action].allSatisfy({ $0.range(of: #"^[a-z0-9_]{1,40}$"#, options: .regularExpression) != nil }),
              let amount = SignedCanonicalJSON.integer(root["amount_rub"]), let maxFinal = SignedCanonicalJSON.integer(root["max_final_rub"]),
              let issued = SignedCanonicalJSON.integer(root["issued_at"]), let expires = SignedCanonicalJSON.integer(root["expires_at"]),
              amount > 0, maxFinal >= amount, expires > issued, expires - issued <= 300,
              let rawParams = root["params"] as? [String: Any], rawParams.count <= 20 else { throw AgentError.message("Некорректные параметры платного действия") }
        var params: [String: String] = [:]
        for (key, value) in rawParams {
            guard key.range(of: #"^[a-z0-9_]{1,40}$"#, options: .regularExpression) != nil else { throw AgentError.message("Некорректные параметры платного действия") }
            if let text = value as? String, text.count <= 300, !hasHiddenCharacters(text) { params[key] = text }
            else if let number = SignedCanonicalJSON.integer(value) { params[key] = String(number) }
            else { throw AgentError.message("Параметр «\(key)» нельзя показать полностью. Подписывать нельзя.") }
        }
        return SignedActionPayload(nonce: nonce, keyId: expectedKey, service: service, action: action, params: params, amountRub: amount, maxFinalRub: maxFinal, issuedAt: issued, expiresAt: expires)
    }

    /// Управляющие и невидимые символы (U+202E, U+200B, переводы строк) показали бы на карточке
    /// не то, что подписывается. Та же проверка — HIDDEN_CHARS в agent/lib/signed-actions.ts.
    static func hasHiddenCharacters(_ text: String) -> Bool {
        text.unicodeScalars.contains { [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) }
    }

    var title: String {
        let services = ["yandex_go": "Яндекс Go", "yandex_delivery": "Яндекс Доставка", "yandex_lavka": "Яндекс Лавка", "yandex_eda": "Яндекс Еда", "yandex_market": "Яндекс Маркет"]
        let actions = ["order_taxi": "Заказ такси", "order_delivery": "Курьер", "order_food": "Заказ", "market_purchase": "Покупка"]
        return "\(actions[action] ?? action) · \(services[service] ?? service)"
    }
    /// Все параметры, без исключений: подпись покрывает каждый.
    var rows: [(label: String, value: String)] {
        let labels = ["from": "Откуда", "to": "Куда", "tariff": "Тариф", "comment": "Комментарий", "payment": "Оплата",
                      "store": "Магазин", "place": "Ресторан", "address": "Адрес", "delivery_rub": "Доставка, ₽", "delivery_max_rub": "Доставка до, ₽"]
        let order = ["store", "place", "address", "from", "to", "tariff", "payment", "delivery_rub", "delivery_max_rub", "comment"]
        // item_01, item_02… — строки корзины: после адреса, до доставки, по номеру.
        func rank(_ key: String) -> Int {
            if let i = order.firstIndex(of: key) { return i < 3 ? i : i + 1 }
            return key.hasPrefix("item_") ? 3 : order.count + 1
        }
        func label(_ key: String) -> String {
            if key.hasPrefix("item_"), let n = Int(key.dropFirst(5)) { return "Товар \(n)" }
            return labels[key] ?? key
        }
        let keys = params.keys.sorted { (rank($0), $0) < (rank($1), $1) }
        return keys.map { (label($0), params[$0]!) }
    }
}

/// Тот же канонический JSON, что `canonicalJson` на сервере.
enum SignedCanonicalJSON {
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(number), abs(number.int64Value) <= 9_007_199_254_740_991 else { return nil }
        return number.intValue
    }
    static func encode(_ value: Any) throws -> String {
        if value is NSNull { return "null" }
        if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
            guard let integer = integer(number) else { throw AgentError.message("payload_invalid") }
            return String(integer)
        }
        if let text = value as? String { return string(text) }
        if let list = value as? [Any] { return "[" + (try list.map(encode)).joined(separator: ",") + "]" }
        if let object = value as? [String: Any] {
            // JavaScript сравнивает ключи по UTF-16 code units.
            let keys = object.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
            return "{" + (try keys.map { string($0) + ":" + (try encode(object[$0]!)) }).joined(separator: ",") + "}"
        }
        throw AgentError.message("payload_invalid")
    }
    /// Экранирование как у JSON.stringify: кавычка, обратный слеш и управляющие символы.
    static func string(_ text: String) -> String {
        var out = "\""
        for unit in text.unicodeScalars {
            switch unit {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case _ where unit.value < 0x20: out += String(format: "\\u%04x", unit.value)
            default: out.unicodeScalars.append(unit)
            }
        }
        return out + "\""
    }
}

enum SigningRefusal {
    static func message(status: Int, body: String) -> String {
        struct Failure: Decodable { let error: String }
        let code = (try? JSONDecoder().decode(Failure.self, from: Data(body.utf8)))?.error ?? ""
        let messages = [
            "forbidden": "Подпись платных действий доступна только владельцу.",
            "signing_unavailable": "Сервер пока не может отправить код. Попробуйте позже.",
            "code_delivery_failed": "Код не дошёл в Telegram. Ключ не сохранён, попробуйте ещё раз.",
            "registration_limit": "Слишком много попыток привязки. Подождите час.",
            "code_invalid": "Неверный код.",
            "code_expired": "Код истёк. Привяжите ключ заново.",
            "code_attempts": "Попытки ввода кода закончились. Привяжите ключ заново.",
            "key_not_pending": "Ключ уже активирован или отозван.",
            "key_unknown": "Сервер не знает этот ключ. Привяжите заново.",
            "key_invalid": "Сервер не принял ключ.",
            "signature_invalid": "Подпись не принята. Действие отменено.",
            "expired": "Срок подтверждения истёк. Действие не выполнено.",
            "nonce_used": "Действие уже подтверждено или отменено.",
            "price_unchecked": "Исполнитель не сверил итоговую цену. Действие не засчитано.",
            "nonce_unknown": "Действие не найдено.",
            "key_revoked": "Ключ этого iPhone отозван. Привяжите его заново.",
            "limit_daily": "Дневной лимит платных действий исчерпан.",
            "limit_amount": "Сумма выше лимита. Такое действие выполните сами.",
            "unauthorized": "Подключение изменилось. Подключите iPhone заново.",
        ]
        return messages[code] ?? "Сервер вернул ошибку \(status)."
    }
}

// MARK: - Secure Enclave

/// Закрытый ключ не покидает Secure Enclave. В Keychain лежит только его
/// зашифрованное представление, пригодное лишь на этом iPhone и лишь после Face ID.
struct SigningKeyRecord: Codable, Equatable {
    let keyId: String
    let device: String
    let key: Data
    var active: Bool
}

enum SigningKeyStore {
    private static let service = "tech.dobropalm.agent.signing"
    static var available: Bool { SecureEnclave.isAvailable }

    static func read(server: String) -> SigningKeyRecord? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server, kSecReturnData as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(SigningKeyRecord.self, from: data)
    }
    static func save(_ record: SigningKeyRecord, server: String) throws {
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server]
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(record), kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly]
        var status = SecItemUpdate(key as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound { status = SecItemAdd(key.merging(attributes) { _, new in new } as CFDictionary, nil) }
        guard status == errSecSuccess else { throw AgentError.message("Не удалось сохранить ключ подписи") }
    }
    static func delete(server: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server] as CFDictionary)
    }
    /// Новый ключ: подпись только после Face ID, смена лиц в Face ID делает ключ непригодным.
    static func create() throws -> SecureEnclave.P256.Signing.PrivateKey {
        guard available else { throw AgentError.message("На этом устройстве нет Secure Enclave") }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error) else {
            throw AgentError.message("Для ключа подписи нужны код-пароль и Face ID")
        }
        return try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
    }
    static func sign(_ payload: String, with record: SigningKeyRecord, reason: String) async throws -> String {
        let context = LAContext()
        context.localizedCancelTitle = "Не подписывать"
        do { try await context.evaluateAccessControl(try accessControl(), operation: .useKeySign, localizedReason: reason) }
        catch { throw AgentError.message("Подпись отменена. Действие не выполнено.") }
        do {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: record.key, authenticationContext: context)
            return try key.signature(for: Data(payload.utf8)).rawRepresentation.base64EncodedString()
        } catch {
            throw AgentError.message("Ключ подписи недоступен. Если менялись лица в Face ID, привяжите ключ заново.")
        }
    }
    private static func accessControl() throws -> SecAccessControl {
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], nil) else {
            throw AgentError.message("Для ключа подписи нужны код-пароль и Face ID")
        }
        return access
    }
}

// MARK: - Models

private func signingCall(_ server: String, _ path: String, body: String? = nil) async throws -> (status: Int, body: String) {
    let response = try await PanelTransport.request(server: server, path: path, method: body == nil ? "GET" : "POST", body: body)
    return (response["status"] as? Int ?? 0, response["body"] as? String ?? "")
}
private func jsonBody(_ fields: [String: String]) -> String { String(data: try! JSONEncoder().encode(fields), encoding: .utf8)! }

@MainActor final class SigningKeyModel: ObservableObject {
    @Published var local: SigningKeyRecord?
    @Published var serverDevice: String?
    @Published var serverKeyId: String?
    @Published var code = ""
    @Published var status = ""
    @Published var working = false

    func load(server: String) async {
        local = SigningKeyStore.read(server: server)
        guard Credentials.read(server: server) != nil else { return }
        do {
            let response = try await signingCall(server, "/api/native/signing/key")
            guard response.status == 200 else { status = SigningRefusal.message(status: response.status, body: response.body); return }
            struct Key: Decodable { let id: String; let device: String }
            struct Reply: Decodable { let key: Key? }
            let key = try JSONDecoder().decode(Reply.self, from: Data(response.body.utf8)).key
            serverKeyId = key?.id; serverDevice = key?.device
            // Сервер активировал другой ключ — этот iPhone больше не подписывает.
            if let record = local, record.active, key?.id != record.keyId {
                SigningKeyStore.delete(server: server); local = nil
                status = "Ключ этого iPhone больше не активен на сервере."
            }
        } catch { status = error.localizedDescription }
    }

    func register(server: String, device: String) async {
        working = true; defer { working = false }
        do {
            let key = try SigningKeyStore.create()
            let spki = key.publicKey.derRepresentation.base64EncodedString()
            let response = try await signingCall(server, "/api/native/signing/keys", body: jsonBody(["device": device, "spki": spki]))
            struct Registered: Decodable { let keyId: String }
            guard response.status == 201, let registered = try? JSONDecoder().decode(Registered.self, from: Data(response.body.utf8)) else {
                status = SigningRefusal.message(status: response.status, body: response.body); return
            }
            let record = SigningKeyRecord(keyId: registered.keyId, device: device, key: key.dataRepresentation, active: false)
            try SigningKeyStore.save(record, server: server)
            local = record; code = ""
            status = "Код отправлен в личные сообщения бота. Введите его в течение 10 минут."
        } catch { status = error.localizedDescription }
    }

    func activate(server: String) async {
        guard var record = local, !record.active else { return }
        working = true; defer { working = false }
        do {
            let response = try await signingCall(server, "/api/native/signing/keys/\(record.keyId)/activate", body: jsonBody(["code": code.trimmingCharacters(in: .whitespaces)]))
            guard response.status == 200 else {
                status = SigningRefusal.message(status: response.status, body: response.body)
                if ["code_expired", "code_attempts", "key_not_pending", "key_unknown"].contains(where: { response.body.contains("\"\($0)\"") }) { SigningKeyStore.delete(server: server); local = nil }
                return
            }
            record.active = true
            try SigningKeyStore.save(record, server: server)
            local = record; code = ""; serverKeyId = record.keyId; serverDevice = record.device
            status = "Ключ подписи активен. Прежний ключ, если был, отозван."
        } catch { status = error.localizedDescription }
    }

    func forget(server: String) {
        SigningKeyStore.delete(server: server); local = nil; code = ""
        status = "Ключ удалён с iPhone. Платные действия подписать нельзя, пока не привяжете новый."
    }
}

@MainActor final class SignedActionsModel: ObservableObject {
    struct Item: Identifiable, Equatable {
        let payload: String
        let action: SignedActionPayload?
        let problem: String?
        let nonce: String
        var id: String { nonce }
    }
    @Published var items: [Item] = []
    @Published var outcomes: [String: String] = [:]
    @Published var working: Set<String> = []
    private var server = ""

    func refresh(server: String) async {
        if self.server != server { self.server = server; items = []; outcomes = [:]; working = [] }
        guard let record = SigningKeyStore.read(server: server), record.active else { items = []; return }
        guard let response = try? await signingCall(server, "/api/native/signing/actions"), response.status == 200, self.server == server else { return }
        struct Pending: Decodable { let nonce: String; let payload: String }
        struct Reply: Decodable { let actions: [Pending] }
        guard let pending = try? JSONDecoder().decode(Reply.self, from: Data(response.body.utf8)).actions else { return }
        let fresh = pending.map { entry -> Item in
            do { return Item(payload: entry.payload, action: try SignedActionPayload.parse(entry.payload, nonce: entry.nonce, expectedKey: record.keyId), problem: nil, nonce: entry.nonce) }
            catch { return Item(payload: entry.payload, action: nil, problem: error.localizedDescription, nonce: entry.nonce) }
        }
        // Решённые карточки остаются, пока владелец видит итог.
        let decided = items.filter { outcomes[$0.nonce] != nil && !fresh.contains($0) }
        items = fresh + decided
    }

    func approve(_ item: Item, server: String) async {
        guard let action = item.action, outcomes[item.nonce] == nil, !working.contains(item.nonce),
              let record = SigningKeyStore.read(server: server), record.active, record.keyId == action.keyId else { return }
        guard Date().timeIntervalSince1970 < Double(action.expiresAt) else { outcomes[item.nonce] = "Срок подтверждения истёк. Действие не выполнено."; return }
        working.insert(item.nonce); defer { working.remove(item.nonce) }
        do {
            let signature = try await SigningKeyStore.sign(item.payload, with: record, reason: "\(action.title): до \(action.maxFinalRub) ₽")
            outcomes[item.nonce] = "Отправляем подпись…"
            let response = try await signingCall(server, "/api/native/signing/actions/\(item.nonce)/approve", body: jsonBody(["signature": signature]))
            outcomes[item.nonce] = response.status == 200 ? "Подписано. Агент выполняет действие и сообщит итог в чате." : SigningRefusal.message(status: response.status, body: response.body)
        } catch let error as AgentError {
            outcomes[item.nonce] = error.localizedDescription
        } catch {
            // Подпись могла дойти до сервера. Повтор не нужен: nonce одноразовый.
            outcomes[item.nonce] = "Результат неизвестен. Проверьте у Агента, прежде чем просить заново."
        }
    }

    func reject(_ item: Item, server: String) async {
        guard outcomes[item.nonce] == nil, !working.contains(item.nonce) else { return }
        working.insert(item.nonce); defer { working.remove(item.nonce) }
        do {
            let response = try await signingCall(server, "/api/native/signing/actions/\(item.nonce)/reject", body: "{}")
            outcomes[item.nonce] = response.status == 200 ? "Отклонено. Действие не выполнено." : SigningRefusal.message(status: response.status, body: response.body)
        } catch { outcomes[item.nonce] = "Не удалось отправить отказ. Без подписи действие всё равно не выполнится." }
    }
}

// MARK: - Views

struct SigningKeySection: View {
    let server: String
    @StateObject private var model = SigningKeyModel()
    var body: some View {
        Section {
            if !SigningKeyStore.available {
                Text("На этом устройстве нет Secure Enclave, подписывать платные действия нельзя.").foregroundStyle(.secondary)
            } else if let local = model.local, local.active {
                HStack {
                    Label("Face ID-ключ активен", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                    Spacer()
                    Menu {
                        Button("Удалить ключ с iPhone", role: .destructive) { model.forget(server: server) }
                    } label: { Image(systemName: "ellipsis.circle").foregroundStyle(.secondary) }
                    .disabled(model.working).accessibilityLabel("Действия с ключом")
                }
            } else if let local = model.local {
                Text("Ключ «\(local.device)» ждёт кода из Telegram.")
                TextField("Код из 6 цифр", text: $model.code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                Button(model.working ? "Проверяем…" : "Активировать") { Task { await model.activate(server: server) } }
                    .disabled(model.working || model.code.trimmingCharacters(in: .whitespaces).range(of: #"^\d{6}$"#, options: .regularExpression) == nil)
                Button("Отменить привязку", role: .destructive) { model.forget(server: server) }.disabled(model.working)
            } else {
                if let device = model.serverDevice { Text("Сейчас подписывает: «\(device)». Новый ключ отзовёт его.").foregroundStyle(.secondary) }
                Button(model.working ? "Создаём ключ…" : "Привязать ключ Face ID") { Task { await model.register(server: server, device: UIDevice.current.name) } }
                    .disabled(model.working || server.isEmpty)
            }
            if !model.status.isEmpty { Text(model.status).font(.footnote) }
        } header: { Text("Ключ подписи") } footer: {
            if model.local?.active != true { Text("Платные действия, например заказ такси, выполняются только после подписи Face ID на этом iPhone. Код привязки придёт в личные сообщения бота.") }
        }
        .task(id: server) { await model.load(server: server) }
    }
}

struct SignedActionCard: View {
    let item: SignedActionsModel.Item
    let outcome: String?
    let working: Bool
    let approve: () -> Void
    let reject: () -> Void
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Платное действие", systemImage: "faceid").font(.headline)
            if let action = item.action {
                Text(action.title).font(.subheadline.weight(.semibold))
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(action.rows.enumerated()), id: \.offset) { _, row in
                        HStack(alignment: .top) { Text(row.label).foregroundStyle(.secondary).frame(width: 110, alignment: .leading); Text(row.value).textSelection(.enabled) }
                    }
                    HStack { Text("Стоимость").foregroundStyle(.secondary).frame(width: 110, alignment: .leading); Text("\(action.amountRub) ₽").bold() }
                    HStack(alignment: .top) { Text("Не дороже").foregroundStyle(.secondary).frame(width: 110, alignment: .leading); Text("\(action.maxFinalRub) ₽ — если цена вырастет сильнее, заказ не оформится") }
                }.font(.footnote)
                if outcome == nil {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let left = action.expiresAt - Int(context.date.timeIntervalSince1970)
                        Text(left > 0 ? "Подписать можно ещё \(left) с" : "Срок подписи истёк").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            } else {
                Text(item.problem ?? "Действие нельзя показать").font(.footnote)
            }
            if let outcome { Text(outcome).font(.subheadline).foregroundStyle(.secondary) }
            else {
                HStack(spacing: 12) {
                    Button("Отклонить", role: .destructive, action: reject).buttonStyle(.bordered)
                    if item.action != nil {
                        Button(action: approve) { Label("Подписать Face ID", systemImage: "faceid").foregroundStyle(scheme == .dark ? Color.black : Color.white) }
                            .buttonStyle(.borderedProminent).tint(scheme == .dark ? Color.white : Color.black)
                    }
                }.controlSize(.large).disabled(working)
            }
            if working { ProgressView().font(.caption) }
        }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 22))
    }
}
