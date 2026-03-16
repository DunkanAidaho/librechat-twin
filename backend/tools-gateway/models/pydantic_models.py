# tools-gateway/models/pydantic_models.py

from typing import Any, Dict, List, Literal, Optional, Union
from datetime import datetime
from pydantic import BaseModel, Field


class DateFilter(BaseModel):
    """
    Pydantic модель для фильтрации по датам.
    """
    model_config = {"populate_by_name": True}
    from_date: Optional[str] = Field(None, alias="from", description="Начальная дата (включительно).")
    to_date: Optional[str] = Field(None, alias="to", description="Конечная дата (включительно).")
    strict_content_only: bool = Field(False, description="Если true, игнорировать created_at и искать только по датам в контенте.")


class GraphContextRequest(BaseModel):
    """
    Pydantic модель для запроса контекста графа.
    Используется для получения связанных данных из Neo4j для заданной беседы.
    """
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    limit: Optional[int] = Field(None, ge=1, description="Максимальное количество элементов контекста для возврата.")


class GraphContextResponse(BaseModel):
    """
    Pydantic модель для ответа с контекстом графа.
    Содержит строки, описывающие контекст, и опциональную подсказку для запроса.
    """
    lines: List[str] = Field(..., description="Список строк, описывающих контекст графа.")
    query_hint: Optional[str] = Field(None, description="Опциональная подсказка для запроса.")
    summary: Optional[str] = Field(None, description="Сводка беседы из графа.")


class TemporalGraphRequest(BaseModel):
    """
    Pydantic модель для запроса на запуск Temporal Workflow по обработке графа.
    Содержит данные сообщения для извлечения сущностей и построения графа.
    """
    user_id: Optional[str] = Field(None, description="Уникальный идентификатор пользователя.")
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    message_id: str = Field(..., description="Уникальный идентификатор сообщения.")
    content: str = Field(..., description="Текстовое содержимое сообщения.")
    created_at: Optional[str] = Field(None, description="Время создания сообщения в формате ISO 8601.")
    reasoning_text: Optional[str] = Field(None, description="Текст рассуждений, связанных с сообщением.")
    context_flags: Optional[List[str]] = Field(default_factory=list, description="Список флагов контекста.")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Произвольные метаданные, связанные с запросом.")


class TemporalMemoryRequest(BaseModel):
    """
    Pydantic модель для запроса на запуск Temporal Workflow по управлению памятью.
    Содержит данные сообщения для обновления памяти агента.
    """
    user_id: Optional[str] = Field(None, description="Уникальный идентификатор пользователя.")
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    message_id: str = Field(..., description="Уникальный идентификатор сообщения.")
    role: str = Field(..., description="Роль отправителя сообщения (e.g., 'user', 'assistant').")
    content: str = Field(..., description="Текстовое содержимое сообщения.")
    created_at: Optional[str] = Field(None, description="Время создания сообщения в формате ISO 8601.")
    reasoning_text: Optional[str] = Field(None, description="Текст рассуждений, связанных с сообщением.")
    context_flags: Optional[List[str]] = Field(default_factory=list, description="Список флагов контекста.")


class MessageForSummary(BaseModel):
    """
    Pydantic модель для отдельного сообщения, используемого в запросах на суммаризацию.
    """
    role: str = Field(..., description="Роль отправителя сообщения (e.g., 'user', 'assistant').")
    content: str = Field(..., description="Текстовое содержимое сообщения.")
    message_id: str = Field(..., description="Уникальный идентификатор сообщения.")
    created_at: Optional[str] = Field(None, description="Время создания сообщения в формате ISO 8601.")


class TemporalSummaryRequest(BaseModel):
    """
    Pydantic модель для запроса на запуск Temporal Workflow по суммаризации.
    Содержит список сообщений для суммаризации и параметры для неё.
    """
    user_id: Optional[str] = Field(None, description="Уникальный идентификатор пользователя.")
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    messages: List[MessageForSummary] = Field(..., description="Список сообщений для суммаризации.")
    start_message_id: str = Field(..., description="ID первого сообщения в диапазоне суммаризации.")
    end_message_id: str = Field(..., description="ID последнего сообщения в диапазоне суммаризации.")
    summary_level: Literal["batch", "conversation", "thread"] = Field(
        "batch", description="Уровень суммаризации (batch, conversation, thread)."
    )
    summary_model: Optional[str] = Field(None, description="Имя модели, используемой для суммаризации.")
    summary_range: Optional[Dict[str, Any]] = Field(
        None, description="Произвольный словарь, описывающий диапазон суммаризации."
    )
    metadata: Optional[Dict[str, Any]] = Field(None, description="Произвольные метаданные, связанные с запросом.")


class SearchRequest(BaseModel):
    """
    Pydantic модель для запроса на векторный поиск.
    """
    query: str = Field(..., description="Поисковый запрос.")
    top_k: int = Field(8, ge=1, le=50, description="Количество топовых результатов для возврата.")
    min_score: float = Field(0.0, ge=0.0, le=2.0, description="Минимальный порог релевантности.")
    embedding_model: Literal["mxbai", "e5"] = Field("mxbai", description="Модель эмбеддингов для использования.")
    conversation_id: Optional[str] = Field(None, description="Опциональный идентификатор беседы для контекстного поиска.")
    user_id: Optional[str] = Field(None, description="Опциональный идентификатор пользователя для контекстного поиска.")
    date_filter: Optional[DateFilter] = Field(None, description="Опциональный фильтр по диапазону дат.")
    include_noise: bool = Field(False, description="Включать ли зашумленные чанки.")
    roles: Optional[List[str]] = Field(None, description="Список ролей для фильтрации.")
    content_type: Optional[str] = Field(None, description="Фильтр по типу контента (metadata.content_type).")
    include_graph: bool = Field(False, description="Включать ли контекст из графа.")


class ChunkMetadata(BaseModel):
    """
    Pydantic модель для метаданных чанка RAG.
    """
    score: float = Field(..., description="Оценка релевантности чанка.")
    match_type: str = Field(..., description="Тип совпадения (vector, keyword, hybrid, graph).")
    role: Optional[str] = Field(None, description="Роль отправителя.")
    created_at: Optional[str] = Field(None, description="Дата создания.")
    content_dates: List[str] = Field(default_factory=list, description="Даты, извлеченные из контента.")
    is_noise: bool = Field(False, description="Флаг шума.")
    entities: List[str] = Field(default_factory=list, description="Список сущностей.")
    source_chunk_id: Optional[str] = Field(None, description="ID исходного чанка.")


class Chunk(BaseModel):
    """
    Pydantic модель для одного чанка результата поиска.
    """
    doc_id: str = Field(..., description="ID документа.")
    chunk_id: int = Field(..., description="ID чанка.")
    content: str = Field(..., description="Текстовое содержимое.")
    metadata: ChunkMetadata = Field(..., description="Метаданные чанка.")
    score: float = Field(..., description="Итоговый score релевантности.")


class SearchResponse(BaseModel):
    """
    Pydantic модель для ответа на запрос векторного поиска.
    """
    query: str = Field(..., description="Исходный поисковый запрос.")
    results: List[Chunk] = Field(..., description="Список найденных фрагментов.")
    graph_context: Optional[GraphContextResponse] = Field(None, description="Контекст из графа знаний.")


class CypherRequest(BaseModel):
    """
    Pydantic модель для запроса на выполнение Cypher-запроса в Neo4j.
    """
    cypher: str = Field(..., description="Строка Cypher-запроса.")
    params: Optional[dict] = Field(None, description="Параметры для Cypher-запроса.")


class CypherResponse(BaseModel):
    """
    Pydantic модель для ответа на Cypher-запрос.
    """
    records: List[dict] = Field(..., description="Список записей, возвращенных Cypher-запросом.")


class HybridRequest(BaseModel):
    """
    Pydantic модель для гибридного запроса (векторный поиск + Cypher).
    """
    query: Optional[str] = Field(None, description="Поисковый запрос для векторного поиска.")
    cypher: Optional[str] = Field(None, description="Cypher-запрос для графовой части.")
    top_k: int = Field(8, ge=1, le=50, description="Количество топовых результатов.")
    alpha: float = Field(0.5, ge=0.0, le=1.0, description="Вес для балансировки между векторным и Cypher поиском.")
    embedding_model: Literal["mxbai", "e5"] = Field("mxbai", description="Модель эмбеддингов.")


class IngestMessageRequest(BaseModel):
    """
    Pydantic модель для запроса на прием (ingest) сообщения.
    Используется для передачи сообщения из фронтенда для обработки контекстом и графом.
    """
    user_id: str = Field(..., description="Уникальный идентификатор пользователя.")
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    message_id: str = Field(..., description="Уникальный идентификатор сообщения.")
    role: str = Field(..., description="Роль отправителя сообщения (e.g., 'user', 'assistant').")
    content: str = Field(..., description="Текстовое содержимое сообщения.")
    created_at: Optional[str] = Field(None, description="Время создания сообщения в формате ISO 8601.")
    reasoning_text: Optional[str] = Field(None, description="Текст рассуждений, связанных с сообщением.")
    context_flags: Optional[List[str]] = Field(None, description="Список флагов контекста.")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Произвольные метаданные, связанные с сообщением.")
    summary: Optional[str] = Field(None, description="Суммаризация сообщения, если доступна.")
    content_dates: Optional[List[str]] = Field(
        None, description="Список дат, относящихся к содержимому сообщения."
    )
    importance_score: Optional[float] = Field(None, description="Вес/важность сообщения.")
    message_index: Optional[int] = Field(None, description="Позиция сообщения в исходной последовательности.")


class IngestSummaryRequest(BaseModel):
    """
    Pydantic модель для запроса на прием (ingest) данных для суммаризации.
    Содержит список сообщений для суммаризации и параметры для неё.
    """
    user_id: Optional[str] = Field(None, description="Уникальный идентификатор пользователя.")
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    messages: List[MessageForSummary] = Field(..., description="Список сообщений для суммаризации.")
    start_message_id: str = Field(..., description="ID первого сообщения в диапазоне суммаризации.")
    end_message_id: str = Field(..., description="ID последнего сообщения в диапазоне суммаризации.")
    summary_level: Literal["batch", "conversation", "thread"] = Field(
        "batch", description="Уровень суммаризации (batch, conversation, thread)."
    )
    summary_text: Optional[str] = Field(
        None, description="Сгенерированный текст резюме (для ingest-пайплайна)."
    )
    summary_range: Optional[Dict[str, Any]] = Field(
        None, description="Диапазон сообщений для суммаризации (идемпотентность)."
    )
    summary_model: Optional[str] = Field(None, description="Имя модели, используемой для суммаризации.")
    status: Literal["ingested", "skipped", "error"] = Field("ingested", description="Статус обработки резюме.")
    metadata: Optional[Dict[str, Any]] = Field(None, description="Произвольные метаданные, связанные с резюме.")


class DeleteConversationRequest(BaseModel):
    """
    Pydantic модель для запроса на удаление беседы.
    """
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы для удаления.")
    user_id: Optional[str] = Field(None, description="Опциональный идентификатор пользователя, которому принадлежит беседа.")


class ExtractedReasoning(BaseModel):
    """
    Pydantic модель для извлеченных рассуждений.
    """
    content: str = Field(..., description="Содержимое рассуждений.")
    message_id: str = Field(..., description="Идентификатор сообщения, к которому относятся рассуждения.")
    created_at: str = Field(..., description="Время создания рассуждений в формате ISO 8601.")


class EntityExtractionRequest(BaseModel):
    """
    Pydantic модель для запроса на извлечение сущностей.
    """
    text: str = Field(..., description="Текст для извлечения сущностей.")
    conversation_id: str = Field(..., description="Идентификатор беседы, к которой относится текст.")
    message_id: str = Field(..., description="Идентификатор сообщения, к которому относится текст.")
    user_id: str = Field(..., description="Идентификатор пользователя.")
    reasoning_text: Optional[str] = Field(None, description="Текст рассуждений, связанных с извлечением.")
    context_flags: Optional[List[str]] = Field(None, description="Список флагов контекста.")


class ExtractedEntity(BaseModel):
    """
    Pydantic модель для одной извлеченной сущности (триплета).
    """
    subject: str = Field(..., description="Субъект.")
    relation: str = Field(..., description="Отношение между субъектом и объектом.")
    object: str = Field(..., description="Объект.")
    subject_type: Optional[str] = Field(None, description="Тип субъекта.")
    object_type: Optional[str] = Field(None, description="Тип объекта.")
    relation_properties: Optional[Dict[str, Any]] = Field(None, description="Свойства отношения.")
    original_relation: Optional[str] = Field(None, description="Оригинальное отношение в тексте.")


class EntityExtractionResponse(BaseModel):
    """
    Pydantic модель для ответа на запрос извлечения сущностей.
    """
    status: str = Field(..., description="Статус операции извлечения сущностей.")
    extracted_entities: List[ExtractedEntity] = Field(..., description="Список извлеченных сущностей.")
    message: Optional[str] = Field(None, description="Опциональное сообщение об операции.")
    context_flags: Optional[List[str]] = Field(default_factory=list, description="Список флагов контекста, извлеченных из текста.")


class IngestGraphDataRequest(BaseModel):
    """
    Pydantic модель для запроса на прием (ingest) данных графа.
    Используется для непосредственной передачи извлеченных сущностей для сохранения в Neo4j.
    """
    user_id: str = Field(..., description="Уникальный идентификатор пользователя.")
    conversation_id: str = Field(..., description="Уникальный идентификатор беседы.")
    message_id: str = Field(..., description="Уникальный идентификатор сообщения.")
    extracted_entities: List[ExtractedEntity] = Field(..., description="Список извлеченных сущностей.")
    created_at: str = Field(..., description="Время создания данных графа в формате ISO 8601.")
    text_content: str = Field(..., description="Исходное текстовое содержимое, из которого были извлечены сущности.")
    reasoning_text: Optional[str] = Field(None, description="Текст рассуждений, связанных с данными графа.")
    context_flags: Optional[List[str]] = Field(None, description="Список флагов контекста.")


class IngestGraphDataResponse(BaseModel):
    """
    Pydantic модель для ответа на запрос приема данных графа.
    """
    status: str = Field(..., description="Статус операции приема данных графа.")
    message: Optional[str] = Field(None, description="Опциональное сообщение об операции.")
    ingested_count: int = Field(0, description="Количество успешно принятых сущностей.")


class ToolRecentMessage(BaseModel):
    """Сообщение из короткого контекста для фасадного поиска."""
    role: Literal["user", "assistant", "system", "tool"] = Field(..., description="Роль сообщения.")
    content: str = Field(..., description="Текстовое содержимое сообщения.")


class ToolSearchFilters(BaseModel):
    """Фильтры фасадного поиска."""
    date_from: Optional[str] = Field(None, description="Начальная дата (ISO 8601).")
    date_to: Optional[str] = Field(None, description="Конечная дата (ISO 8601).")
    roles: Optional[List[str]] = Field(None, description="Ограничение по ролям.")
    content_types: Optional[List[str]] = Field(None, description="Список типов контента.")


class ToolSearchContextRequest(BaseModel):
    """Публичный контракт фасада /tool/search_context."""
    model_config = ConfigDict(populate_by_name=True)

    query: str = Field(..., description="Поисковый запрос.")
    chat_id: str = Field(..., description="Идентификатор чата.")
    message_id: Optional[str] = Field(None, description="Идентификатор сообщения.")
    user_id: Optional[str] = Field(None, description="Идентификатор пользователя.")
    agent: Optional[str] = Field(None, description="Идентификатор агента.")
    recent_messages: Optional[List[ToolRecentMessage]] = Field(
        None, description="Короткий контекст последних сообщений."
    )
    model_token_limit: Optional[int] = Field(
        1128000,
        alias="model_limit",
        description="Лимит токенов модели.",
    )
    filters: Optional[ToolSearchFilters] = Field(None, description="Фильтры фасадного поиска.")
    include_graph: Optional[bool] = Field(True, description="Включать ли графовый контекст.")


class ToolBudgetHint(BaseModel):
    """Подсказка по бюджету токенов для контекста."""
    context_tokens: int = Field(..., description="Оценка числа токенов в контексте.")
    recommended_output_tokens: int = Field(..., description="Рекомендованный бюджет на ответ модели.")


class ToolContextPack(BaseModel):
    """Упакованный контекст для отправки в LLM."""
    short_context: Optional[str] = Field(None, description="Короткий контекст последних сообщений.")
    retrieved_chunks: List[Chunk] = Field(..., description="Чанки из vector/keyword поиска.")
    graph_context: Optional[GraphContextResponse] = Field(None, description="Графовый контекст.")
    summaries: List[str] = Field(default_factory=list, description="Список summaries (пока пусто).")
    sources: List[Dict[str, Any]] = Field(default_factory=list, description="Список источников.")
    budget_hint: ToolBudgetHint = Field(..., description="Подсказка по токен-бюджету.")


class ToolSearchContextResponse(BaseModel):
    """Ответ фасада /tool/search_context."""
    status: Literal["ok", "error"] = Field(..., description="Статус выполнения.")
    context_pack: ToolContextPack = Field(..., description="Собранный контекст.")


class ToolSubmitIngestRequest(BaseModel):
    """Публичный контракт фасада /tool/submit_ingest."""
    chat_id: str = Field(..., description="Идентификатор чата.")
    message_id: Optional[str] = Field(None, description="Идентификатор сообщения.")
    user_id: Optional[str] = Field(None, description="Идентификатор пользователя.")
    agent: Optional[str] = Field(None, description="Идентификатор агента.")
    content: Optional[str] = Field(None, description="Текст для ingest.")
    ingest_profile: Optional[Literal["graph_only", "summary_only", "memory_only", "full"]] = Field(
        "full", description="Профиль ingest."
    )
    metadata: Optional[Dict[str, Any]] = Field(None, description="Произвольные метаданные.")
    idempotency_key: Optional[str] = Field(None, description="Ключ идемпотентности.")
    role: Optional[str] = Field(None, description="Роль отправителя (для memory ingest).")
    source_system: Optional[str] = Field(None, description="Система-источник (librechat/telegram/webhook).")
    source_chat_id: Optional[str] = Field(None, description="ID беседы в системе-источнике.")
    source_message_id: Optional[str] = Field(None, description="ID сообщения в системе-источнике.")
    source_user_id: Optional[str] = Field(None, description="ID пользователя в системе-источнике.")
    workspace_id: Optional[str] = Field(None, description="ID workspace/tenant, если доступно.")


class ToolSubmitIngestResponse(BaseModel):
    """Ответ фасада /tool/submit_ingest."""
    status: Literal["queued", "error"] = Field(..., description="Статус постановки в очередь.")
    job_id: str = Field(..., description="ID корневого ingest workflow.")
    ingest_profile: Literal["graph_only", "summary_only", "memory_only", "full"] = Field(
        ..., description="Использованный ingest профиль."
    )
