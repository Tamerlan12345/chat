# App-specific R8 rules are intentionally empty. Kotlinx Serialization and
# OkHttp provide their own consumer rules; broad keeps here would prevent
# release shrinking without protecting a demonstrated reflection boundary.
