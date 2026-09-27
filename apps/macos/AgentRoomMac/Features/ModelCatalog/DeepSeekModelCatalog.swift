import Foundation

/// The `deepseek` section: the whole model list, since DeepSeek has no list call.
struct DeepSeekModelCatalog: Codable, Equatable {
    var models: [DeepSeekCatalogModel]
}
