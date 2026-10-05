package com.openmychat.mobile.contract

import com.openmychat.mobile.data.delivery.DeliveryReducer
import com.openmychat.mobile.data.delivery.DeliveryState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import java.io.File

/**
 * `mobile/contracts/delivery-state.md` §11: every vector in `fixtures/reducers/` runs through the
 * Android reducer. The directory is walked (not a list), so a new vector is checked the moment it
 * lands. Effects of each event are compared exactly (order, fields, values); the final state is
 * compared key by key for the keys the vector names.
 */
@RunWith(Parameterized::class)
class DeliveryReducerVectorsTest(private val name: String, private val file: File) {

    @Test
    fun vector() {
        val vector = json.parseToJsonElement(file.readText()).jsonObject
        assertEquals("name matches the file", file.nameWithoutExtension, (vector["name"] as? kotlinx.serialization.json.JsonPrimitive)?.content)
        var state = DeliveryState.fromJson(vector.getValue("initialState").jsonObject)
        val events = vector.getValue("events").jsonArray
        val expectedEffects = vector.getValue("expectedEffects").jsonArray
        assertEquals("one effect list per event", events.size, expectedEffects.size)

        events.forEachIndexed { i, event ->
            val input = state.toJson()
            val step = DeliveryReducer.reduce(state, event.jsonObject)
            assertEquals("the input state is never changed (event $i)", input, state.toJson())
            val actual = JsonArray(step.effects.map { it.toJson() })
            assertEquals("$name: effects of event $i (${event.jsonObject["type"]})", expectedEffects[i], actual)
            state = step.state
        }

        val expected = vector.getValue("expectedState").jsonObject
        val actual = state.toJson()
        for ((key, value) in expected) {
            assertEquals("$name: expectedState.$key", value, actual[key])
        }
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun vectors(): List<Array<Any>> {
            val dir = locate()
            val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }!!.sortedBy { it.name }
            assertTrue("vectors present in $dir", files.isNotEmpty())
            return files.map { arrayOf(it.nameWithoutExtension, it) }
        }

        private fun locate(): File {
            val start = File(requireNotNull(System.getProperty("user.dir")))
            return generateSequence(start) { it.parentFile }
                .flatMap { sequenceOf(File(it, "contracts/fixtures/reducers"), File(it, "mobile/contracts/fixtures/reducers")) }
                .firstOrNull { it.isDirectory }
                ?: error("mobile/contracts/fixtures/reducers not found above $start")
        }
    }
}
