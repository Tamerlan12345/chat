package com.openmychat.mobile.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class NavBackStack(initialKey: NavKey) {
    private val _stack = mutableStateListOf(initialKey)
    val stack: List<NavKey> get() = _stack

    val currentKey: NavKey get() = _stack.lastOrNull() ?: NavKey.ServerConnect

    fun navigate(key: NavKey) {
        _stack.add(key)
    }

    fun pop(): Boolean {
        if (_stack.size > 1) {
            _stack.removeAt(_stack.lastIndex)
            return true
        }
        return false
    }

    fun replace(key: NavKey) {
        if (_stack.isNotEmpty()) {
            _stack.removeAt(_stack.lastIndex)
        }
        _stack.add(key)
    }

    fun clearAndSet(key: NavKey) {
        _stack.clear()
        _stack.add(key)
    }

    fun popUpTo(targetKey: NavKey, inclusive: Boolean = false): Boolean {
        val index = _stack.indexOfLast { it == targetKey }
        if (index != -1) {
            val removeCount = _stack.size - if (inclusive) index else (index + 1)
            repeat(removeCount) {
                if (_stack.size > 1) _stack.removeAt(_stack.lastIndex)
            }
            return true
        }
        return false
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        val Saver = listSaver<NavBackStack, String>(
            save = { backStack ->
                backStack.stack.map { key -> json.encodeToString(key) }
            },
            restore = { savedList ->
                val restored = savedList.mapNotNull { str ->
                    try {
                        json.decodeFromString<NavKey>(str)
                    } catch (_: Exception) {
                        null
                    }
                }
                val initial = restored.firstOrNull() ?: NavKey.ServerConnect
                NavBackStack(initial).apply {
                    if (restored.size > 1) {
                        for (i in 1 until restored.size) {
                            navigate(restored[i])
                        }
                    }
                }
            }
        )
    }
}

@Composable
fun rememberNavBackStack(initialKey: NavKey): NavBackStack {
    return rememberSaveable(saver = NavBackStack.Saver) {
        NavBackStack(initialKey)
    }
}
