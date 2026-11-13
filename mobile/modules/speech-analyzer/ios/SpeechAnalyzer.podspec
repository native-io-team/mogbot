Pod::Spec.new do |s|
  s.name           = 'SpeechAnalyzer'
  s.version        = '1.0.0'
  s.summary        = "Dictation on iOS 26's SpeechAnalyzer + SpeechTranscriber"
  s.description    = "The phone's dictation recognizer on iOS 26 and later (mobile/src/lib/speechAnalyzer.ts)."
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://example.invalid'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
