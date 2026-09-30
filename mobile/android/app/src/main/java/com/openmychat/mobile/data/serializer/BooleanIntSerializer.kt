package com.openmychat.mobile.data.serializer

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Custom serializer for Boolean values that can arrive as:
 * - standard boolean (true / false)
 * - integer representation (1 / 0) common in SQLite databases
 * - string representation ("1", "0", "true", "false")
 */
object BooleanIntSerializer : KSerializer<Boolean> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("BooleanIntSerializer", PrimitiveKind.BOOLEAN)

    override fun serialize(encoder: Encoder, value: Boolean) {
        encoder.encodeBoolean(value)
    }

    override fun deserialize(decoder: Decoder): Boolean {
        return if (decoder is JsonDecoder) {
            val element: JsonElement = decoder.decodeJsonElement()
            if (element is JsonPrimitive) {
                element.booleanOrNull
                    ?: element.intOrNull?.let { it != 0 }
                    ?: when (element.content.lowercase()) {
                        "1", "true", "yes" -> true
                        "0", "false", "no" -> false
                        else -> false
                    }
            } else {
                false
            }
        } else {
            try {
                decoder.decodeBoolean()
            } catch (e: Exception) {
                decoder.decodeInt() != 0
            }
        }
    }
}
