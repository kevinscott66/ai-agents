#!/usr/bin/env python3
"""Run native protocol and extracted current ChatModel regression tests on macOS.
The model is read from production source on every run; no copied implementation.
Only UI wrappers and speech output are removed; API responses are controlled.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='agent-ios-tests-') as scratch:
    temp = Path(scratch)
    compiler = ['xcrun', 'swiftc', '-module-cache-path', str(temp / 'cache')]
    api = temp / 'api-check'
    subprocess.run(compiler + [str(root / 'Agent/API.swift'), str(root / 'tests/APIValidation.swift'), '-o', str(api)], check=True, timeout=90)
    subprocess.run([str(api)], check=True, timeout=60)
    source = (root / 'Agent/AgentApp.swift').read_text()
    model = source[source.index('struct ChatLine:'):source.index('struct AgentGlass:')]
    model = model[:model.index('    func speak(')] + '}\n'
    model = model.replace(': ObservableObject', '').replace('@Published ', '')
    model = model.replace('    private let speaker = AVSpeechSynthesizer()\n', '')
    fixture = (root / 'tests/ChatStateFixture.swift').read_text().replace('// MODEL_UNDER_TEST', model)
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
    subprocess.run(['xcrun', 'swiftc', '-module-cache-path', str(temp / 'cache'), str(root / 'Agent/API.swift'), str(temp / 'PanelTransport.swift'), str(root / 'tests/PanelTransportFixture.swift'), '-o', str(temp / 'panel')], check=True, timeout=90)
    subprocess.run([str(temp / 'panel')], check=True, timeout=15)

with tempfile.TemporaryDirectory(prefix='agent-approvals-tests-') as scratch:
    temp = Path(scratch)
    source = (root / 'Agent/ChatApprovals.swift').read_text().split('struct ChatApprovalCard: View')[0]
    source = source.replace('import SwiftUI', '').replace(': ObservableObject', '').replace('@Published ', '')
    fixture = (root / 'tests/ChatApprovalFixture.swift').read_text().replace('// MODEL', source)
    (temp / 'Approvals.swift').write_text(fixture)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-module-cache-path', str(temp / 'cache'), str(temp / 'Approvals.swift'), '-o', str(temp / 'test')], check=True, timeout=90)
    subprocess.run([str(temp / 'test')], check=True, timeout=15)
