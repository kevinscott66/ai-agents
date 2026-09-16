import SwiftUI
import CoreLocation

struct ActionsView: View {
    let prepare: (String) -> Void
    private let work: [(String, String, String)] = [
        ("Начать день", "sun.max", "Агент, начни мой день"),
        ("Календарь", "calendar", "Агент, покажи календарь"),
        ("Рабочий Mac", "desktopcomputer", "Агент, открой рабочие приложения"),
        ("Итоги дня", "moon", "Агент, подведи итоги дня"),
        ("Уведомления", "bell", "Агент, включи уведомления"),
        ("Без уведомлений", "bell.slash", "Агент, выключи уведомления"),
        ("GitHub", "chevron.left.forwardslash.chevron.right", "Агент, проверь мои активные проекты в GitHub: PR, проверки и блокирующие задачи. Используй доступные инструменты, укажи что проверено."),
        ("Серверы", "server.rack", "Агент, проверь состояние моих серверов по настроенным подключениям. Покажи недоступные сервисы и ошибки. Сначала диагностика."),
        ("Домены и DNS", "globe", "Агент, проверь мои домены, DNS и сертификаты через настроенные подключения. Сначала покажи диагностику."),
        ("Cloudflare", "cloud", "Агент, проверь мои проекты Cloudflare через настроенное подключение. Покажи состояние и что требует внимания.")
    ]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Что сделать?").font(.title2.weight(.semibold))
                Text("Быстрый старт для рабочих и повседневных дел.").foregroundStyle(.secondary)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                    ForEach(work, id: \.0) { title, icon, prompt in
                        Button { prepare(prompt) } label: {
                            VStack(alignment: .leading, spacing: 16) {
                                Image(systemName: icon).font(.title2).foregroundStyle(.primary)
                                Text(title).font(.headline).foregroundStyle(.primary)
                            }.frame(maxWidth: .infinity, minHeight: 86, alignment: .leading).padding(16)
                                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
                        }.buttonStyle(.plain)
                    }
                }
                Text("ПО ЖИЗНИ").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                NavigationLink { TaxiView() } label: { service("Такси", "Маршрут в Яндекс Go", "car.fill") }
                NavigationLink { TransferView() } label: { service("Перевод", "Подготовить данные для Т‑Банка", "rublesign.circle") }
            }.padding(20)
        }.navigationTitle("Действия").navigationBarTitleDisplayMode(.inline)
    }
    private func service(_ title: String, _ subtitle: String, _ icon: String) -> some View {
        HStack(spacing: 16) {
            Image(systemName: icon).font(.title2).foregroundStyle(.primary).frame(width: 32)
            VStack(alignment: .leading, spacing: 4) { Text(title).font(.headline); Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            Spacer(); Image(systemName: "chevron.right").foregroundStyle(.secondary)
        }.foregroundStyle(.primary).padding(18).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}
struct TaxiView: View {
    @Environment(\.openURL) private var openURL
    @State private var start = ""
    @State private var destination = ""
    @State private var route: URL?
    @State private var routeDescription = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("Маршрут") {
                TextField("Откуда: город, улица, дом", text: $start)
                TextField("Куда: город, улица, дом", text: $destination)
                Button(busy ? "Ищем адреса…" : "Подготовить маршрут") { Task { await buildRoute() } }.disabled(busy || start.isEmpty || destination.isEmpty)
            }
            if let error { Section { Text(error).foregroundStyle(.orange) } }
            if let route {
                Section("Проверьте адреса") {
                    Text(routeDescription)
                    Button("Открыть маршрут в Яндекс Go") { openURL(route) }
                    Text("Тариф, стоимость, способ оплаты и заказ подтверждаются в Яндекс Go.").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }.navigationTitle("Такси")
            .onChange(of: start) { _, _ in route = nil }.onChange(of: destination) { _, _ in route = nil }
    }
    @MainActor private func buildRoute() async {
        busy = true; error = nil; route = nil
        let requestedStart = start, requestedDestination = destination
        defer { busy = false }
        do {
            let first = try await CLGeocoder().geocodeAddressString(requestedStart)
            let second = try await CLGeocoder().geocodeAddressString(requestedDestination)
            guard first.count == 1, second.count == 1, let a = first.first, let b = second.first,
                  let from = a.location?.coordinate, let to = b.location?.coordinate else {
                throw AgentError.message("Адрес неоднозначен. Добавьте город и номер дома.")
            }
            var parts = URLComponents(string: "https://3.redirect.appmetrica.yandex.com/route")!
            parts.queryItems = [URLQueryItem(name: "start-lat", value: String(from.latitude)), URLQueryItem(name: "start-lon", value: String(from.longitude)),
                                URLQueryItem(name: "end-lat", value: String(to.latitude)), URLQueryItem(name: "end-lon", value: String(to.longitude)),
                                URLQueryItem(name: "ref", value: "agentapp"), URLQueryItem(name: "appmetrica_tracking_id", value: "25395763362139037"), URLQueryItem(name: "lang", value: "ru")]
            guard start == requestedStart && destination == requestedDestination else { return }
            route = parts.url
            let address: (CLPlacemark) -> String = { p in [p.locality, p.thoroughfare, p.subThoroughfare].compactMap { $0 }.joined(separator: ", ") }
            routeDescription = "\(address(a))\n↓\n\(address(b))"
        } catch { if start == requestedStart && destination == requestedDestination { self.error = error.localizedDescription } }
    }
}
enum TransferAmount {
    static func normalized(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard value.range(of: #"^[0-9]+(?:\.[0-9]{1,2})?$"#, options: .regularExpression) != nil,
              let number = Decimal(string: value, locale: Locale(identifier: "en_US_POSIX")), !number.isNaN, number > 0 else { return nil }
        return NSDecimalNumber(decimal: number).stringValue
    }
}
struct TransferView: View {
    @Environment(\.openURL) private var openURL
    @State private var recipient = ""
    @State private var amount = ""
    @State private var purpose = ""
    @State private var copied = false
    private var valid: Bool { !recipient.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && TransferAmount.normalized(amount) != nil }
    var body: some View {
        Form {
            Section("Подготовить перевод") {
                TextField("Получатель / телефон / реквизиты", text: $recipient)
                TextField("Сумма в рублях", text: $amount).keyboardType(.decimalPad)
                TextField("Назначение", text: $purpose)
            }
            Section {
                Button(copied ? "Данные скопированы" : "Скопировать данные перевода") {
                    UIPasteboard.general.setItems([["public.utf8-plain-text": "Получатель: \(recipient)\nСумма: \(TransferAmount.normalized(amount) ?? amount) ₽\nНазначение: \(purpose)"]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
                    copied = true
                }.disabled(!valid)
                Button("Открыть Т‑Банк") { openURL(URL(string: "https://www.tbank.ru/mybank/")!) }
            } footer: {
                Text("Это подготовка данных. Проверьте получателя и сумму и выполните перевод в банке. Банковские реквизиты из этой формы не отправляются лиду.")
            }
        }.navigationTitle("Перевод")
            .onChange(of: recipient) { _, _ in copied = false }
            .onChange(of: amount) { _, _ in copied = false }
            .onChange(of: purpose) { _, _ in copied = false }
    }
}
