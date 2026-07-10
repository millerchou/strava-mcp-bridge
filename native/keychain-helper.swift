import Foundation
import Security

let allowedServicePattern = #"^Strava MCP Bridge(?: [A-Za-z0-9._-]+)?-credentials$"#
let itemLabel = "Strava MCP Bridge credentials"
let itemComment = "OAuth credentials for strava-mcp-bridge. Created by the local Keychain helper."

struct Command: Decodable {
    let op: String
    let service: String
    let account: String?
    let value: String?
}

struct SuccessResponse: Encodable {
    let ok: Bool
    let found: Bool?
    let value: String?
}

struct ErrorResponse: Encodable {
    let ok: Bool
    let error: String
    let status: Int32?
}

func writeJSON<T: Encodable>(_ value: T, to handle: FileHandle) {
    do {
        let data = try JSONEncoder().encode(value)
        handle.write(data)
        handle.write(Data([0x0a]))
    } catch {
        let fallback = #"{"ok":false,"error":"failed to encode response"}"#
        handle.write(Data(fallback.utf8))
        handle.write(Data([0x0a]))
    }
}

func fail(_ message: String, status: OSStatus? = nil) -> Never {
    writeJSON(ErrorResponse(ok: false, error: message, status: status), to: .standardError)
    exit(1)
}

func keychainQuery(service: String, account: String?) -> [String: Any] {
    guard service.range(of: allowedServicePattern, options: .regularExpression) != nil else {
        fail("service is not allowed")
    }

    guard let account, account == NSUserName() else {
        fail("account must match the current macOS user")
    }

    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
    return query
}

func readPassword(service: String, account: String?) {
    var query = keychainQuery(service: service, account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
        writeJSON(SuccessResponse(ok: true, found: false, value: nil), to: .standardOutput)
        return
    }
    guard status == errSecSuccess else {
        fail("SecItemCopyMatching failed", status: status)
    }
    guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
        fail("Keychain item data is not UTF-8")
    }
    writeJSON(SuccessResponse(ok: true, found: true, value: value), to: .standardOutput)
}

func writePassword(service: String, account: String?, value: String?) {
    guard let value else {
        fail("write operation requires value")
    }
    guard let data = value.data(using: .utf8) else {
        fail("value is not UTF-8")
    }

    let query = keychainQuery(service: service, account: account)
    let attributes: [String: Any] = [
        kSecValueData as String: data,
    ]
    let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if updateStatus == errSecSuccess {
        writeJSON(SuccessResponse(ok: true, found: nil, value: nil), to: .standardOutput)
        return
    }
    if updateStatus != errSecItemNotFound {
        fail("SecItemUpdate failed", status: updateStatus)
    }

    var addQuery = query
    addQuery[kSecValueData as String] = data
    addQuery[kSecAttrLabel as String] = itemLabel
    addQuery[kSecAttrComment as String] = itemComment
    addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        fail("SecItemAdd failed", status: addStatus)
    }
    writeJSON(SuccessResponse(ok: true, found: nil, value: nil), to: .standardOutput)
}

func deletePassword(service: String, account: String?) {
    let query = keychainQuery(service: service, account: account)
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound {
        writeJSON(SuccessResponse(ok: true, found: false, value: nil), to: .standardOutput)
        return
    }
    guard status == errSecSuccess else {
        fail("SecItemDelete failed", status: status)
    }
    writeJSON(SuccessResponse(ok: true, found: true, value: nil), to: .standardOutput)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let command: Command
do {
    command = try JSONDecoder().decode(Command.self, from: input)
} catch {
    fail("invalid JSON command")
}

switch command.op {
case "read":
    readPassword(service: command.service, account: command.account)
case "write":
    writePassword(service: command.service, account: command.account, value: command.value)
case "delete":
    deletePassword(service: command.service, account: command.account)
default:
    fail("unknown operation")
}
