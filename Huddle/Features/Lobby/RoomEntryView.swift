import SwiftUI

/// Create-or-join. First visit asks for a display name (dev identity
/// until Sign in with Apple); after that it's two moves: start a room,
/// or type a code someone read across the table.
struct RoomEntryView: View {
    @Environment(UserSession.self) private var session
    private let api = HuddleAPIClient()

    @State private var nameField = ""
    @State private var codeField = ""
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var room: RoomDTO?

    var body: some View {
        VStack(spacing: 0) {
            if session.isRegistered {
                roomControls
            } else {
                nameGate
            }
        }
        .padding(24)
        .background(Color(.systemBackground))
        .navigationTitle("Rooms")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $room) { room in
            RoomSessionView(viewModel: RoomSessionViewModel(
                room: room, api: api, myUserId: session.userId ?? ""))
        }
    }

    // MARK: First run: pick a name

    private var nameGate: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("What should friends call you?")
                .font(.system(.title3, design: .rounded, weight: .bold))
            TextField("Your name", text: $nameField)
                .textFieldStyle(.plain)
                .font(.system(.title2, design: .rounded, weight: .semibold))
                .multilineTextAlignment(.center)
                .padding(.vertical, 14)
                .background(Color(.secondarySystemBackground),
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .submitLabel(.done)
                .onSubmit { register() }
            Spacer()
            primaryButton("Continue", disabled: nameField.trimmingCharacters(in: .whitespaces).isEmpty || busy) {
                register()
            }
            errorLine
        }
    }

    private func register() {
        let name = nameField.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do { try await session.register(displayName: name) }
            catch { errorMessage = error.localizedDescription }
        }
    }

    // MARK: Create / join

    private var roomControls: some View {
        VStack(spacing: 16) {
            Spacer()
            Text("Hi, \(session.displayName ?? "")")
                .font(.system(.title3, design: .rounded, weight: .bold))
                .frame(maxWidth: .infinity, alignment: .leading)

            primaryButton("Create a room", disabled: busy) {
                perform { try await api.createRoom(hostId: session.userId ?? "") }
            }

            HStack(spacing: 10) {
                TextField("Join code", text: $codeField)
                    .textFieldStyle(.plain)
                    .font(.system(.title3, design: .monospaced, weight: .bold))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                    .padding(.vertical, 12)
                    .padding(.horizontal, 16)
                    .background(Color(.secondarySystemBackground),
                                in: Capsule())
                    .onSubmit { join() }
                Button {
                    join()
                } label: {
                    Image(systemName: "arrow.right")
                        .font(.system(size: 18, weight: .bold))
                        .frame(width: 48, height: 48)
                        .background(Color.primary, in: Circle())
                        .foregroundStyle(Color(.systemBackground))
                }
                .disabled(codeField.trimmingCharacters(in: .whitespaces).isEmpty || busy)
            }
            errorLine
            Spacer()
        }
    }

    private func join() {
        let code = codeField.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { return }
        perform { try await api.joinRoom(code: code, userId: session.userId ?? "") }
    }

    private func perform(_ call: @escaping () async throws -> RoomDTO) {
        guard !busy else { return }
        busy = true
        errorMessage = nil
        Task {
            defer { busy = false }
            do { room = try await call() }
            catch { errorMessage = error.localizedDescription }
        }
    }

    // MARK: Bits

    private func primaryButton(_ title: String, disabled: Bool,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(.headline, design: .rounded))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Color.primary, in: Capsule())
                .foregroundStyle(Color(.systemBackground))
        }
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1)
    }

    @ViewBuilder
    private var errorLine: some View {
        if let errorMessage {
            Text(errorMessage)
                .font(.system(.footnote, design: .rounded))
                .foregroundStyle(Color(.systemRed))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
