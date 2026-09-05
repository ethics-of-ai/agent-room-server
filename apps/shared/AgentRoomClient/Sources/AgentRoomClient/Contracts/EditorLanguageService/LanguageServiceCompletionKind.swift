import Foundation

public enum LanguageServiceCompletionKind: String, Codable, Hashable, Sendable {
    case text, method, function, constructor, field, variable, `class`, interface, module
    case property, value, `enum`, keyword, file, reference, folder, constant, `struct`, event
    case `operator`, other
    case enumMember = "enum_member"
    case typeParameter = "type_parameter"
}
