package com.openmychat.mobile.data.model

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive

object StringOrIntSerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("StringOrIntSerializer", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: String) {
        encoder.encodeString(value)
    }

    override fun deserialize(decoder: Decoder): String {
        return if (decoder is JsonDecoder) {
            val element = decoder.decodeJsonElement()
            if (element is JsonPrimitive) {
                element.content
            } else {
                element.toString()
            }
        } else {
            decoder.decodeString()
        }
    }
}

@Serializable
data class FileUploadResponse(
    @SerialName("id")
    @Serializable(with = StringOrIntSerializer::class)
    val id: String,

    @SerialName("originalName")
    val originalName: String,

    @SerialName("storedFilename")
    val storedFilename: String,

    @SerialName("fileSize")
    val fileSize: Long,

    @SerialName("mimeType")
    val mimeType: String,

    @SerialName("url")
    val url: String
)

@Serializable
data class FilePolicy(
    @SerialName("enabled")
    val enabled: Boolean = true,

    @SerialName("allowed")
    val allowed: List<String> = emptyList()
) {
    /**
     * Checks if the given file extension is allowed by the server policy.
     */
    fun isExtensionAllowed(extension: String): Boolean {
        if (!enabled) return true
        val cleanExt = extension.trim().removePrefix(".").lowercase()
        if (cleanExt.isBlank()) return false
        return allowed.isEmpty() || allowed.any { it.trim().removePrefix(".").lowercase() == cleanExt }
    }
}
