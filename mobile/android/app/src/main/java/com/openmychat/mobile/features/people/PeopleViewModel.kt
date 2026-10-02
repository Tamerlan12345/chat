package com.openmychat.mobile.features.people

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.openmychat.mobile.core.network.ConnectionState
import com.openmychat.mobile.data.repository.PeopleRepository
import com.openmychat.mobile.data.repository.PeopleState
import com.openmychat.mobile.data.repository.RealtimeRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

enum class PeopleScope { ALL, DEPARTMENTS }

/** Что попросили показать на «Сотрудниках» из другого места: запрос из поиска «Чатов» или отдел из карточки. */
sealed interface PeopleRequest {
    data class Search(val query: String) : PeopleRequest
    data class Department(val departmentId: Long) : PeopleRequest
}

/** Передача [PeopleRequest] во вкладку «Сотрудники», чья ViewModel живёт в своей записи стека. */
@Singleton
class PeopleRequests @Inject constructor() {
    private val _pending = MutableStateFlow<PeopleRequest?>(null)
    val pending: StateFlow<PeopleRequest?> = _pending.asStateFlow()

    fun send(request: PeopleRequest) {
        _pending.value = request
    }

    fun consume(): PeopleRequest? = _pending.value.also { _pending.value = null }
}

data class PeopleUiState(
    val isLoaded: Boolean = false,
    val isRefreshing: Boolean = false,
    val refreshFailed: Boolean = false,
    val total: Int = 0,
    val online: Int = 0,
    val query: String = "",
    val scope: PeopleScope = PeopleScope.ALL,
    val onlineOnly: Boolean = false,
    /** «Все» без запроса: разделы А–Я. */
    val sections: List<LetterSection> = emptyList(),
    /** «Все» с запросом: ранжированная выдача. */
    val results: List<PersonMatch> = emptyList(),
    /** «Отделы»: отфильтрованное дерево. */
    val departments: List<DepartmentNode> = emptyList(),
    val expanded: Set<Long> = emptySet()
) {
    val isSearching: Boolean get() = query.isNotBlank()

    /** Нечего показать при включённом фильтре или запросе. */
    val isEmptyResult: Boolean
        get() = isLoaded && when (scope) {
            PeopleScope.ALL -> if (isSearching) results.isEmpty() else sections.isEmpty()
            PeopleScope.DEPARTMENTS -> departments.isEmpty()
        }
}

private data class PeopleFilters(
    val query: String = "",
    val scope: PeopleScope = PeopleScope.ALL,
    val onlineOnly: Boolean = false,
    /** null — как на настольном клиенте: верхний уровень раскрыт, пока сотрудник ничего не трогал. */
    val expanded: Set<Long>? = null
)

@HiltViewModel
class PeopleViewModel @Inject constructor(
    private val repository: PeopleRepository,
    private val requests: PeopleRequests,
    realtime: RealtimeRepository
) : ViewModel() {

    val connectionState: StateFlow<ConnectionState> = realtime.connectionState

    private val filters = MutableStateFlow(PeopleFilters())
    private val _state = MutableStateFlow(PeopleUiState())
    val state: StateFlow<PeopleUiState> = _state.asStateFlow()

    init {
        repository.refresh()
        viewModelScope.launch {
            combine(repository.state, filters) { data, f -> present(data, f) }.collect { _state.value = it }
        }
        viewModelScope.launch {
            requests.pending.collect { pending -> if (pending != null) apply(requests.consume() ?: return@collect) }
        }
    }

    fun setQuery(query: String) = filters.update { it.copy(query = query) }

    fun setScope(scope: PeopleScope) = filters.update { it.copy(scope = scope) }

    fun toggleOnlineOnly() = filters.update { it.copy(onlineOnly = !it.onlineOnly) }

    fun toggleDepartment(id: Long) = filters.update {
        val current = it.expanded ?: defaultExpanded()
        it.copy(expanded = if (id in current) current - id else current + id)
    }

    private fun defaultExpanded(): Set<Long> =
        PeopleDirectory.departments(repository.state.value.tree, repository.state.value.people).mapTo(HashSet()) { it.id }

    fun refresh() = repository.refresh()

    private fun apply(request: PeopleRequest) {
        when (request) {
            is PeopleRequest.Search -> filters.update { it.copy(query = request.query, scope = PeopleScope.ALL) }
            is PeopleRequest.Department -> {
                val path = PeopleDirectory.pathTo(PeopleDirectory.departments(repository.state.value.tree, repository.state.value.people), request.departmentId)
                filters.update { it.copy(query = "", scope = PeopleScope.DEPARTMENTS, onlineOnly = false, expanded = (it.expanded ?: defaultExpanded()) + path) }
            }
        }
    }

    private fun present(data: PeopleState, f: PeopleFilters): PeopleUiState {
        val visible = if (f.onlineOnly) data.people.filter { it.status.isReachable } else data.people
        val searching = f.query.isNotBlank()
        // В «Отделах» сотрудник видит и себя: счётчики совпадают с десктопом и totalStaffCount сервера.
        val everyone = data.people + listOfNotNull(data.self)
        val tree = if (f.scope == PeopleScope.DEPARTMENTS) {
            PeopleDirectory.filter(PeopleDirectory.departments(data.tree, everyone), f.query, f.onlineOnly)
        } else emptyList()
        return PeopleUiState(
            isLoaded = data.isLoaded,
            isRefreshing = data.isRefreshing,
            refreshFailed = data.refreshFailed,
            total = data.people.size,
            online = PeopleDirectory.onlineCount(data.people),
            query = f.query,
            scope = f.scope,
            onlineOnly = f.onlineOnly,
            sections = if (f.scope == PeopleScope.ALL && !searching) PeopleDirectory.sections(visible) else emptyList(),
            results = if (f.scope == PeopleScope.ALL && searching) PeopleSearch.rank(visible, f.query) else emptyList(),
            departments = tree,
            // Поиск раскрывает найденные ветки (как на настольном клиенте); фильтр «В сети» — тоже.
            expanded = when {
                searching || f.onlineOnly -> PeopleDirectory.allIds(tree)
                f.expanded != null -> f.expanded
                else -> tree.mapTo(HashSet()) { it.id }
            }
        )
    }
}
