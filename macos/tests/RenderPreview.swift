import SwiftUI
@main struct RenderPreview {
 @MainActor static func main() throws {
    let dir=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer{try? FileManager.default.removeItem(at:dir)}
    let model=DesktopModel(directory:dir),voice=Voice(),automation=Automation(directory:dir)
    let content=Dashboard(section:.constant("Обзор")).environmentObject(model).environmentObject(voice).environmentObject(automation).padding(30).frame(width:850,height:820).background(Color(nsColor:.windowBackgroundColor)).tint(Color(red:0.32,green:0.41,blue:0.32))
    let renderer=ImageRenderer(content:content);renderer.scale=2
    guard let image=renderer.nsImage,let tiff=image.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {throw DesktopError.message("Render unavailable")}
    try png.write(to:URL(fileURLWithPath:"/tmp/agent-dashboard-preview.png"));print("Preview rendered")
 }
}
