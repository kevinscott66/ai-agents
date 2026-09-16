import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import PDFKit
import CoreLocation
import QuickLook
import ImageIO

struct PickedMedia: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let source = received.file
            let size = (try source.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
            guard size <= 250 * 1024 * 1024 else { throw AgentError.message("Исходный файл больше 250 МБ. Выберите более короткий ролик.") }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(source.pathExtension)
            try FileManager.default.copyItem(at: source, to: url)
            return PickedMedia(url: url)
        }
    }
}

enum MediaPreparation {
    static let maxBytes = 10 * 1024 * 1024
    static func photo(_ data: Data, name: String = "Фото.jpg") throws -> AttachmentDraft {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = info[kCGImagePropertyPixelWidth] as? Int, let height = info[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 50000, height <= 50000, Int64(width) * Int64(height) <= 80_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 2048, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else {
            throw AgentError.message("Не удалось прочитать изображение или оно слишком большое")
        }
        let jpeg = try jpegData(UIImage(cgImage: image), limit: 4 * 1024 * 1024)
        return AttachmentDraft(id: UUID().uuidString.lowercased(), name: name, mimeType: "image/jpeg", data: jpeg)
    }
    private static func jpegData(_ image: UIImage, limit: Int) throws -> Data {
        for quality in [0.82, 0.65, 0.45, 0.25] {
            if let data = image.jpegData(compressionQuality: quality), data.count <= limit { return data }
        }
        throw AgentError.message("Изображение слишком большое")
    }
    static func file(_ url: URL, displayName: String? = nil) async throws -> AttachmentDraft {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let info = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard info.isRegularFile == true else { throw AgentError.message("Выберите файл") }
        let type = UTType(filenameExtension: url.pathExtension) ?? .data
        let name = String((displayName ?? url.lastPathComponent).prefix(80))
        if type.conforms(to: .movie) { return try await video(url, name: name) }
        guard let size = info.fileSize, size <= maxBytes, size > 0 else { throw AgentError.message("Максимальный размер файла — 10 МБ") }
        try Task.checkCancellation()
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        if type.conforms(to: .image) { return try photo(data, name: (name as NSString).deletingPathExtension + ".jpg") }
        var result = AttachmentDraft(id: UUID().uuidString.lowercased(), name: name, mimeType: type.preferredMIMEType ?? "application/octet-stream", data: data)
        if type.conforms(to: .pdf) {
            guard let pdf = PDFDocument(data: data), !pdf.isLocked else { throw AgentError.message("PDF защищён паролем или повреждён") }
            var text = ""
            for index in 0..<min(pdf.pageCount, 100) {
                try Task.checkCancellation()
                if text.utf16.count >= 15000 { break }
                if let value = pdf.page(at: index)?.string { text += value + "\n" }
            }
            result.text = String(decoding: Array(text.utf16.prefix(14000)), as: UTF16.self) + "\n[PDF: \(pdf.pageCount) страниц; текст и первые 3 страницы могут быть представлены частично.]"
            for index in 0..<min(pdf.pageCount, 3) {
                try Task.checkCancellation()
                if let page = pdf.page(at: index), let jpeg = try? jpegData(page.thumbnail(of: CGSize(width: 1000, height: 1000), for: .mediaBox), limit: 512 * 1024) {
                    result.previews.append(AttachmentPreview(mimeType: "image/jpeg", data: jpeg.base64EncodedString()))
                }
            }
        } else if type.conforms(to: .text) || ["json", "csv", "md", "log", "yaml", "yml", "xml"].contains(url.pathExtension.lowercased()) {
            if let text = String(data: data.prefix(1_000_000), encoding: .utf8) {
                result.text = String(decoding: Array(text.utf16.prefix(14000)), as: UTF16.self) + (text.count > 14000 || data.count > 1_000_000 ? "\n[Текст обрезан по лимиту.]" : "")
            }
        }
        return result
    }
    private static func video(_ url: URL, name: String) async throws -> AttachmentDraft {
        let size = (try url.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? Int.max
        guard size <= 250 * 1024 * 1024 else { throw AgentError.message("Исходный ролик больше 250 МБ") }
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0, duration <= 120 else { throw AgentError.message("Выберите видео длительностью до 2 минут") }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { try? FileManager.default.removeItem(at: output) }
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1280x720) else { throw AgentError.message("Не удалось подготовить видео") }
        export.outputURL = output; export.outputFileType = .mp4; export.shouldOptimizeForNetworkUse = true
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in export.exportAsynchronously { continuation.resume() } }
        } onCancel: { export.cancelExport() }
        try Task.checkCancellation()
        guard export.status == .completed else { throw AgentError.message("Не удалось сжать видео") }
        let bytes = (try output.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? Int.max
        guard bytes <= maxBytes else { throw AgentError.message("После сжатия видео больше 10 МБ. Выберите более короткий фрагмент.") }
        var result = AttachmentDraft(id: UUID().uuidString.lowercased(), name: (name as NSString).deletingPathExtension + ".mp4", mimeType: "video/mp4", data: try Data(contentsOf: output))
        result.text = "Видео длительностью \(Int(duration)) с. Приложены кадры начала, середины и конца; звук не расшифрован. Кадры не описывают весь ролик."
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 1000, height: 1000)
        for seconds in [0.0, duration / 2, max(0, duration - 0.2)] {
            try Task.checkCancellation()
            let time = CMTime(seconds: seconds, preferredTimescale: 600)
            if let image = try? await generator.image(at: time).image,
               let data = try? jpegData(UIImage(cgImage: image), limit: 512 * 1024) {
                result.previews.append(AttachmentPreview(mimeType: "image/jpeg", data: data.base64EncodedString()))
            }
        }
        return result
    }
}

@MainActor final class LocationPicker: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published var loading = false
    @Published var error: String?
    private let manager = CLLocationManager()
    private var completion: ((SharedLocation) -> Void)?
    private var timeout: Task<Void, Never>?
    override init() { super.init(); manager.delegate = self; manager.desiredAccuracy = kCLLocationAccuracyHundredMeters }
    func request(_ completion: @escaping (SharedLocation) -> Void) {
        guard !loading else { return }
        self.completion = completion; error = nil; loading = true
        timeout = Task { try? await Task.sleep(for: .seconds(20)); if !Task.isCancelled && loading { fail("Не удалось определить место. Повторите попытку.") } }
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        else { requestAuthorized() }
    }
    private func requestAuthorized() {
        guard loading else { return }
        guard [.authorizedAlways, .authorizedWhenInUse].contains(manager.authorizationStatus) else { fail("Разрешите геопозицию в настройках iPhone"); return }
        manager.requestLocation()
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { if manager.authorizationStatus != .notDetermined { requestAuthorized() } }
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard loading else { return }
        guard let fix = locations.last, fix.horizontalAccuracy >= 0, abs(fix.timestamp.timeIntervalSinceNow) < 60 else { fail("Геопозиция устарела. Повторите попытку."); return }
        let callback = completion
        cancel()
        callback?(SharedLocation(latitude: fix.coordinate.latitude, longitude: fix.coordinate.longitude, accuracy: fix.horizontalAccuracy))
    }
    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { guard loading else { return }; fail("Геопозиция недоступна. Проверьте разрешение и сигнал.") }
    private func fail(_ message: String) { cancel(); error = message }
    func cancel() { manager.stopUpdatingLocation(); timeout?.cancel(); timeout = nil; completion = nil; loading = false }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onImage) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController(); picker.sourceType = .camera; picker.delegate = context.coordinator; return picker
    }
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let completion: (UIImage?) -> Void
        init(_ completion: @escaping (UIImage?) -> Void) { self.completion = completion }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { completion(nil) }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) { completion(info[.originalImage] as? UIImage) }
    }
}

/// Original bytes stay in a protected temporary file; ImageIO only decodes a bounded thumbnail.
struct AttachmentRow: View {
    let attachment: NativeAttachment
    let server: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var loading = false
    @State private var error: String?
    @State private var preview: URL?
    @State private var file: URL?
    @State private var thumbnail: UIImage?
    @State private var requested = false
    @State private var loadID = UUID()
    private var isImage: Bool { attachment.mimeType.hasPrefix("image/") }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { if let file { preview = file } else { requested = true; retryID = UUID() } } label: {
                if isImage {
                    ZStack {
                        RoundedRectangle(cornerRadius: 22).fill(Color(uiColor: .secondarySystemBackground))
                        if let thumbnail {
                            Image(uiImage: thumbnail).resizable().scaledToFit().transition(.opacity)
                        } else {
                            VStack(spacing: 12) {
                                Image(systemName: "photo").font(.title)
                                Text(loading ? "Загрузка изображения…" : "Изображение недоступно").font(.subheadline)
                            }.foregroundStyle(.secondary).padding()
                        }
                    }.frame(maxWidth: .infinity).frame(height: 280).clipShape(RoundedRectangle(cornerRadius: 22))
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: attachment.mimeType.hasPrefix("video/") ? "video" : "doc").font(.title2)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: attachment.name).lineLimit(2)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.size), countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        if loading { ProgressView() }
                    }.padding(14).frame(minHeight: 56).background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
                }
            }.buttonStyle(.plain).disabled(loading).accessibilityLabel("Открыть " + attachment.name)
            if let file {
                ShareLink(item: file) { Label("Сохранить или поделиться", systemImage: "square.and.arrow.up").font(.subheadline).frame(minHeight: 44) }
                    .foregroundStyle(.secondary)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.secondary)
                Button("Загрузить снова") { retryID = UUID() }.frame(minHeight: 44)
            }
        }.quickLookPreview($preview)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: thumbnail != nil)
            .task(id: server + attachment.id + retryID.uuidString) { if isImage || requested { await load() } }
            .onDisappear { loadID = UUID(); cleanUp() }
    }
    @State private var retryID = UUID()
    private func cleanUp() {
        if let file { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        file = nil; thumbnail = nil
    }
    @MainActor private func load() async {
        let operation = UUID(); loadID = operation
        cleanUp(); loading = true; error = nil
        defer { if loadID == operation { loading = false } }
        guard let token = Credentials.read(server: server) else { error = "Подключите устройство"; return }
        do {
            let data = try await AgentAPI(server: server).download(attachment, expectedToken: token)
            try Task.checkCancellation()
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("agent-preview-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            var retained = false
            defer { if !retained { try? FileManager.default.removeItem(at: folder) } }
            let name = String((attachment.name as NSString).lastPathComponent.prefix(120))
            let url = folder.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "Вложение" : name)
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            var decoded: UIImage?
            if isImage {
                decoded = await Task.detached(priority: .utility) {
                    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                          let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 1200, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil as UIImage? }
                    return UIImage(cgImage: image)
                }.value
            }
            try Task.checkCancellation()
            guard loadID == operation else { throw CancellationError() }
            guard Credentials.read(server: server) == token else { throw AgentError.message("Подключение изменилось") }
            thumbnail = decoded
            file = url; retained = true
            if requested { preview = url }
        } catch is CancellationError { }
        catch { if loadID == operation { self.error = error.localizedDescription } }
    }
}

struct GenerationCanvas: View {
    let status: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    private var running: Bool { status == "running" }
    private var label: String {
        switch status {
        case "running": return "Создаю изображение…"
        case "interrupted": return "Создание прервано перезапуском сервера"
        default: return "Не удалось создать изображение"
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TimelineView(.animation(minimumInterval: 1.0 / 20, paused: !running || reduceMotion || scenePhase != .active)) { timeline in
                let phase = reduceMotion ? 0 : timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 5) / 5
                GeometryReader { geometry in
                    ZStack {
                        Color(uiColor: .secondarySystemBackground)
                        if running {
                            Ellipse().fill(Color.primary.opacity(0.08)).frame(width: 240, height: 200).blur(radius: 38).offset(x: cos(phase * .pi * 2) * 70, y: sin(phase * .pi * 2) * 35)
                            LinearGradient(colors: [.clear, Color.primary.opacity(0.07), .clear], startPoint: .leading, endPoint: .trailing)
                                .frame(width: geometry.size.width * 0.8).rotationEffect(.degrees(25)).offset(x: (phase * 2 - 1) * geometry.size.width)
                        }
                        Image(systemName: running ? "sparkles" : "photo.badge.exclamationmark").font(.system(size: 28, weight: .light)).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity).clipped()
                }
            }.frame(height: 280).clipShape(RoundedRectangle(cornerRadius: 22)).accessibilityHidden(true)
            Text(label).font(.subheadline).foregroundStyle(.secondary)
            if !running { Text("Уточните состояние задачи перед новым запросом.").font(.caption).foregroundStyle(.secondary) }
        }.accessibilityElement(children: .combine).accessibilityLabel(label)
    }
}

#if DEBUG
struct GenerationPreview: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text("Создай спокойный пейзаж").padding().background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 24))
                    GenerationCanvas(status: "running")
                    GenerationCanvas(status: "interrupted")
                }.padding(22)
            }.navigationTitle("Агент").navigationBarTitleDisplayMode(.inline)
        }.tint(.primary)
    }
}
struct MediaSelfTestView: View {
    @State private var result = "Проверяем подготовку медиа…"
    var body: some View {
        Text(result).padding().task {
            let folder = FileManager.default.temporaryDirectory.appendingPathComponent("media-selftest-" + UUID().uuidString)
            do {
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: folder) }
                let picture = UIGraphicsImageRenderer(size: CGSize(width: 640, height: 480)).image { context in
                    UIColor.systemBlue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 640, height: 480))
                }
                let photo = try MediaPreparation.photo(picture.pngData()!)
                guard photo.mimeType == "image/jpeg", !photo.data.isEmpty else { throw AgentError.message("photo fixture") }
                let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 400, height: 400)).pdfData { context in
                    for _ in 0..<2 { context.beginPage(); ("Attachment fixture text" as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: [.font: UIFont.systemFont(ofSize: 16)]) }
                }
                let pdfURL = folder.appendingPathComponent("fixture.pdf"); try pdf.write(to: pdfURL)
                let document = try await MediaPreparation.file(pdfURL)
                guard document.text?.contains("Attachment fixture text") == true, document.previews.count == 2 else { throw AgentError.message("PDF fixture") }
                let textURL = folder.appendingPathComponent("fixture.txt"); try Data("Проверка файла".utf8).write(to: textURL)
                let text = try await MediaPreparation.file(textURL)
                guard text.text == "Проверка файла" else { throw AgentError.message("text fixture") }
                let movieURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("media-fixture.mp4")
                let movie = try await MediaPreparation.file(movieURL)
                guard movie.mimeType == "video/mp4", movie.previews.count == 3, !movie.data.isEmpty else { throw AgentError.message("video fixture") }
                result = "PASS: photo JPEG, PDF text + pages, text file, video MP4 + three frames"
            } catch { result = "FAIL: " + error.localizedDescription }
            let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("media-selftest.txt")
            try? Data(result.utf8).write(to: output, options: .atomic)
        }
    }
}
#endif
