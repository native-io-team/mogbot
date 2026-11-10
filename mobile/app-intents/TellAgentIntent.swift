import AppIntents
internal import ExpoAppIntents
import Foundation

// "Tell <app>…" / "Tell <agent> in <app>…": Siri asks for the words, opens
// the app, and the app sends them (src/lib/siri.ts). This file only records
// the request: there is no reply channel back from JavaScript, so Siri is
// told the app is opening to send it, never that it was sent.

/// One of your agents, by name, from the catalog the app publishes
/// (`setEntityCatalogAsync('agent', …)`). Names only.
struct AgentEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Agent"
  static let defaultQuery = AgentQuery()

  var id: String
  @Property(title: "Name")
  var name: String
  var subtitle: String?
  var synonyms: [String]

  var displayRepresentation: DisplayRepresentation {
    if let subtitle {
      if #available(iOS 17.0, *) {
        return DisplayRepresentation(
          title: "\(name)",
          subtitle: "\(subtitle)",
          synonyms: synonyms.map { LocalizedStringResource(stringLiteral: $0) }
        )
      }
      return DisplayRepresentation(title: "\(name)", subtitle: "\(subtitle)")
    }
    if #available(iOS 17.0, *) {
      return DisplayRepresentation(
        title: "\(name)",
        synonyms: synonyms.map { LocalizedStringResource(stringLiteral: $0) }
      )
    }
    return DisplayRepresentation(title: "\(name)")
  }

  init(record: AppIntentEntityRecord) {
    self.id = record.id
    self.subtitle = record.subtitle
    self.synonyms = record.synonyms
    self.name = record.title
  }

  func matches(_ search: String) -> Bool {
    let wanted = AgentEntity.fold(search)
    guard !wanted.isEmpty else { return false }
    return ([name] + synonyms).map(AgentEntity.fold).contains { term in
      wanted == term || wanted.contains(term) || term.contains(wanted)
    }
  }

  static func fold(_ value: String) -> String {
    value
      .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

struct AgentQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [AgentEntity] {
    try await AppIntentEntityStore.shared.entities(ofKind: "agent", matching: identifiers)
      .map(AgentEntity.init(record:))
  }

  func suggestedEntities() async throws -> [AgentEntity] {
    try await AppIntentEntityStore.shared.entities(ofKind: "agent")
      .map(AgentEntity.init(record:))
  }

  func entities(matching string: String) async throws -> [AgentEntity] {
    try await suggestedEntities().filter { $0.matches(string) }
  }
}

/// "Tell <app>…": to the Chief of Staff.
struct TellChiefIntent: AppIntent {
  static let title: LocalizedStringResource = "Tell Your Chief of Staff"
  static let description = IntentDescription(
    "Sends a message to your Chief of Staff, as if you'd typed it."
  )
  static let openAppWhenRun: Bool = true

  @Parameter(title: "Message", requestValueDialog: "What should I tell them?")
  var message: String

  static var parameterSummary: some ParameterSummary {
    Summary("Tell your Chief of Staff \(\.$message)")
  }

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let words = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty else { return .result(dialog: "There was nothing to send.") }
    await handOver(words, to: nil)
    return .result(dialog: "Opening the app to send that.")
  }
}

/// "Tell <agent> in <app>…": to the agent named, from the catalog.
struct TellAgentIntent: AppIntent {
  static let title: LocalizedStringResource = "Tell an Agent"
  static let description = IntentDescription(
    "Sends a message to one of your agents, as if you'd typed it."
  )
  static let openAppWhenRun: Bool = true

  @Parameter(title: "Agent", requestValueDialog: "Which agent?")
  var agent: AgentEntity

  @Parameter(title: "Message", requestValueDialog: "What should I tell them?")
  var message: String

  static var parameterSummary: some ParameterSummary {
    Summary("Tell \(\.$agent) \(\.$message)")
  }

  @MainActor
  func perform() async throws -> some IntentResult & ProvidesDialog {
    let words = message.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty else { return .result(dialog: "There was nothing to send.") }
    await handOver(words, to: agent)
    return .result(dialog: "Opening the app to send that to \(agent.name).")
  }
}

/// Records the request for the app (src/lib/siri.ts), which sends it once open.
private func handOver(_ words: String, to agent: AgentEntity?) async {
  var params: AppIntentParams = ["text": .string(words)]
  if let agent {
    params["agentId"] = .string(agent.id)
    params["agentName"] = .string(agent.name)
  }
  await AppIntentDispatcher.shared.dispatch(name: "tellAgent", params: params)
}

/// The phrases. Each must name the app (`.applicationName`); the agent's may
/// name one from the catalog. The words are always asked for next.
struct AppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: TellChiefIntent(),
      phrases: [
        "Tell \(.applicationName)",
        "Ask \(.applicationName)",
        "Message \(.applicationName)",
      ],
      shortTitle: "Tell Your Chief of Staff",
      systemImageName: "bubble.left"
    )
    AppShortcut(
      intent: TellAgentIntent(),
      phrases: [
        "Tell \(\.$agent) in \(.applicationName)",
        "Ask \(\.$agent) in \(.applicationName)",
        "Message \(\.$agent) in \(.applicationName)",
      ],
      shortTitle: "Tell an Agent",
      systemImageName: "person.bubble"
    )
  }
}
