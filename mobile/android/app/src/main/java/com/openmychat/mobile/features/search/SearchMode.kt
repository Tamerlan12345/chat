package com.openmychat.mobile.features.search

/** Режим поиска на «Чатах»: поле и выдача берут его из одного места — фокус или текст в поле. */
object SearchMode {
    fun isActive(focused: Boolean, query: String): Boolean = focused || query.isNotEmpty()
}
