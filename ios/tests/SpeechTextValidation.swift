import Foundation
@main struct Check {
    static func main() {
        precondition(SpeechText.normalize("# Готово\n\n- **Первый** шаг\n2. Второй шаг") == "Готово\n\nПервый шаг\nВторой шаг")
        precondition(SpeechText.normalize("Откройте [настройки](https://example.test/settings).") == "Откройте настройки.")
        precondition(SpeechText.normalize("До\n```swift\nprint(\"secret\")\n```\nПосле") == "До\n\nПосле")
        precondition(SpeechText.normalize("```unfinished\nне читать") == "")
        precondition(SpeechText.normalize("https://example.test/secret?token=abc") == "")
        precondition(SpeechText.normalize("![photo](https://example.test/p.png)") == "")
        precondition(SpeechText.normalize("Текст `имя` и <b>разметка</b>.") == "Текст имя и разметка.")
        precondition(SpeechText.normalize(String(repeating: "я", count: 30_000)).count == 24_000)
        print("Speech text normalization: PASS")
    }
}
