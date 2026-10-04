package com.openmychat.mobile.ui.navigation

/** Подписи нижней панели не растут выше 1.3x: при шрифте 2.0 четыре подписи иначе не помещаются. */
object NavLabelScale {
    const val MAX = 1.3f

    fun cap(fontScale: Float): Float = fontScale.coerceAtMost(MAX)
}
