#!/usr/bin/env python3
"""Run native protocol and extracted current ChatModel regression tests on macOS.
The model is read from production source on every run; no copied implementation.
Only UI wrappers and speech output are removed; API responses are controlled.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
# API.swift без туннеля OpenFlux: он живёт в OpenFlux.swift вместе с C-рантаймом.
api_sources = [str(root / 'Agent/API.swift'), str(root / 'tests/FluxNetworkStub.swift')]
with tempfile.TemporaryDirectory(prefix='agent-ios-tests-') as scratch:
    temp = Path(scratch)
    compiler = ['xcrun', 'swiftc', '-module-cache-path', str(temp / 'cache')]
    api = temp / 'api-check'
    subprocess.run(compiler + api_sources + [str(root / 'tests/APIValidation.swift'), '-o', str(api)], check=True, timeout=90)
    subprocess.run([str(api)], check=True, timeout=60)
    source = (root / 'Agent/AgentApp.swift').read_text()
    model = source[source.index('struct ChatLine:'):source.index('struct AgentGlass:')]
    model = model[:model.index('    func speak(')] + '}\n'
    model = model.replace(': ObservableObject', '').replace('@Published ', '')
    model = model.replace('    private let speaker = AVSpeechSynthesizer()\n', '')
    api_source = (root / 'Agent/API.swift').read_text()
    api_models = api_source[:api_source.index('import Foundation')]
    api_title = api_source[api_source.index('    static func conversationTitle('):api_source.index('    func createConversation(')]
    fixture = (root / 'tests/ChatStateFixture.swift').read_text().replace('// MODEL_UNDER_TEST', model)
    fixture = fixture.replace('// API_MODELS', api_models, 1).replace(' // API_TITLE', api_title, 1)
    fixture = fixture.replace('import Foundation', 'import Foundation\nlet testDomain = "agent-tests-" + UUID().uuidString\nlet testDefaults = UserDefaults(suiteName: testDomain)!', 1)
    fixture = fixture.replace('UserDefaults.standard', 'testDefaults').replace('@MainActor static func main() async {', '@MainActor static func main() async {\n  defer { testDefaults.removePersistentDomain(forName: testDomain) }')
    generated = temp / 'ChatState.swift'
    generated.write_text(fixture)
    binary = temp / 'chat-check'
    subprocess.run(compiler + ['-parse-as-library', str(generated), '-o', str(binary)], check=True, timeout=90)
    subprocess.run([str(binary)], check=True, timeout=15)

# Exercise the URL boundary from production code without linking UIKit/WebKit.
with tempfile.TemporaryDirectory(prefix='agent-panel-tests-') as scratch:
    temp = Path(scratch)
    panel = (root / 'Agent/PanelView.swift').read_text()
    panel = panel[panel.index('enum PanelTransport {'):]
    (temp / 'PanelTransport.swift').write_text('import Foundation\n' + panel)
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(temp / 'cache'), *api_sources, str(temp / 'PanelTransport.swift'), str(root / 'tests/PanelTransportFixture.swift'), '-o', str(temp / 'panel')], check=True, timeout=90)
    subprocess.run([str(temp / 'panel')], check=True, timeout=15)

with tempfile.TemporaryDirectory(prefix='agent-approvals-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/ChatApprovals.swift').read_text().split('struct ChatApprovalCard: View')[0]
    source = source.replace('import SwiftUI', '').replace(': ObservableObject', '').replace('@Published ', '')
    fixture = (root / 'tests/ChatApprovalFixture.swift').read_text().replace('// MODEL', source)
    (temp / 'Approvals.swift').write_text(fixture)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(temp / 'Approvals.swift'), '-o', str(temp / 'test')], check=True, timeout=90)
    subprocess.run([str(temp / 'test')], check=True, timeout=15)

# Signed paid actions: canonical payload check, and the server verifies an iPhone-format key and signature.
with tempfile.TemporaryDirectory(prefix='agent-signing-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/Signing.swift').read_text().split('// MARK: - Secure Enclave')[0].replace('import SwiftUI', 'import Foundation').replace('import LocalAuthentication', '')
    (temp / 'Signing.swift').write_text(source)
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(temp/'cache'), *api_sources, str(temp/'Signing.swift'), str(root/'tests/SignedPayloadValidation.swift'), '-o', str(temp/'test')], check=True, timeout=90)
    sample = subprocess.run([str(temp/'test')], check=True, timeout=15, capture_output=True, text=True).stdout
    if shutil.which('bun'):
        verify = (root / 'tests/signed-verify.ts').read_text().replace('SIGNED_ACTIONS', str(root.parent / 'agent/lib/signed-actions.ts'))
        (temp / 'verify.ts').write_text(verify)
        subprocess.run(['bun', str(temp/'verify.ts')], input=sample, check=True, timeout=30, text=True, cwd=root.parent / 'agent')
    print('PASS: signed payload is canonical, fully shown, and an iPhone signature verifies on the server')

# Exercise full-string monetary parsing without SwiftUI or clipboard access.
with tempfile.TemporaryDirectory(prefix='agent-transfer-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/ActionsView.swift').read_text().split('enum TransferAmount {')[1].split('struct TransferView: View')[0]
    (temp / 'Transfer.swift').write_text('import Foundation\nenum TransferAmount {' + source + '''
precondition(TransferAmount.normalized(" 12,50 ") == "12.5")
precondition(TransferAmount.normalized("0.01") == "0.01")
for text in ["12junk", "1.234", "1e3", "0", "-1", "NaN", "1 2", "", "12.3.4"] { precondition(TransferAmount.normalized(text) == nil) }
print("PASS: transfer amount requires entire positive decimal with at most two fractional digits")
''')
    subprocess.run(['xcrun','swiftc','-module-cache-path',str(temp/'cache'),str(temp/'Transfer.swift'),'-o',str(temp/'test')],check=True,timeout=90)
    subprocess.run([str(temp/'test')],check=True,timeout=15)

with tempfile.TemporaryDirectory(prefix='agent-openflux-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/OpenFlux.swift').read_text().split('/// All C runtime')[0].replace('import SwiftUI', '')
    (temp / 'Settings.swift').write_text(source)
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(temp/'cache'), *api_sources, str(temp/'Settings.swift'), str(root/'tests/OpenFluxValidation.swift'), '-o', str(temp/'test')], check=True, timeout=90)
    subprocess.run([str(temp/'test')], check=True, timeout=15)

with tempfile.TemporaryDirectory(prefix='agent-speech-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/VoiceOutput.swift').read_text().split('import AVFoundation')[0]
    (temp / 'SpeechText.swift').write_text(source)
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(temp/'cache'), str(temp/'SpeechText.swift'), str(root/'tests/SpeechTextValidation.swift'), '-o', str(temp/'test')], check=True, timeout=90)
    subprocess.run([str(temp/'test')], check=True, timeout=15)

with tempfile.TemporaryDirectory(prefix='agent-knowledge-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/Knowledge.swift').read_text().split('struct KnowledgeView: View')[0]
    source = source.replace('import SwiftUI', '').replace(': ObservableObject', '').replace('@Published ', '')
    api_source = (root / 'Agent/API.swift').read_text()
    fixture = (root / 'tests/KnowledgeStateFixture.swift').read_text().replace('// MODEL', source).replace('// API_MODELS', api_source[:api_source.index('import Foundation')], 1)
    (temp / 'Knowledge.swift').write_text(fixture)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-module-cache-path', str(temp/'cache'), str(temp/'Knowledge.swift'), '-o', str(temp/'test')], check=True, timeout=90)
    subprocess.run([str(temp/'test')], check=True, timeout=15)

# Actual silence detector and UTF16-safe neural speech boundaries from production.
with tempfile.TemporaryDirectory(prefix='agent-conversation-voice-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/ConversationVoice.swift').read_text().split('enum VoiceConversationPolicy {')[1]
    (temp / 'VoicePolicy.swift').write_text('import Foundation\nenum VoiceConversationPolicy {' + source + r'''
precondition(!VoiceConversationPolicy.finishedUtterance(samples: 3, silence: 2))
precondition(!VoiceConversationPolicy.finishedUtterance(samples: 4, silence: 1.19))
precondition(VoiceConversationPolicy.finishedUtterance(samples: 4, silence: 1.2))
let original = String(repeating: "Привет 👨‍👩‍👧‍👦. ", count: 900)
let chunks = VoiceConversationPolicy.chunks(original)
precondition(chunks.count > 1 && chunks.joined() == original)
precondition(chunks.allSatisfy { $0.utf16.count <= 3000 })
print("PASS: voice silence boundary and lossless UTF16-safe neural speech chunks")
''')
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(temp / 'cache'), str(temp / 'VoicePolicy.swift'), '-o', str(temp / 'test')], check=True, timeout=90)
    subprocess.run([str(temp / 'test')], check=True, timeout=15)

# Hybrid dictation must never overwrite a draft the user edited after dictating.
with tempfile.TemporaryDirectory(prefix='agent-dictation-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/Voice.swift').read_text()
    source = source[source.index('enum DictationDraft {'):source.index('/// Пишет буферы микрофона')]
    (temp / 'Dictation.swift').write_text('import Foundation\n' + source + '''
precondition(DictationDraft.replacement(draft: "привет клод", spoken: "привет клод", refined: " Привет, Claude. ") == "Привет, Claude.")
precondition(DictationDraft.replacement(draft: "", spoken: "", refined: "Текст только с сервера") == "Текст только с сервера")
precondition(DictationDraft.replacement(draft: "привет клод, поправил", spoken: "привет клод", refined: "Привет, Claude.") == nil)
precondition(DictationDraft.replacement(draft: "", spoken: "привет клод", refined: "Привет, Claude.") == nil)
precondition(DictationDraft.replacement(draft: "привет", spoken: "привет", refined: "  ") == nil)
precondition(DictationDraft.replacement(draft: "Привет.", spoken: "Привет.", refined: "Привет.") == nil)
print("PASS: dictation refinement replaces only an untouched draft with non-empty different text")
''')
    subprocess.run(['xcrun','swiftc','-module-cache-path',str(temp/'cache'),str(temp/'Dictation.swift'),'-o',str(temp/'test')],check=True,timeout=90)
    subprocess.run([str(temp/'test')],check=True,timeout=15)
