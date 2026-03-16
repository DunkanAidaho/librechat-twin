import copy
import json
import os

import requests
from flask import Flask, render_template, request

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET", "dev-secret-key")

TOKEN = os.environ.get("TELEGRAPH_TOKEN")
AUTHOR_NAME = os.environ.get("AUTHOR_NAME", "ПолитКонтекст")
AUTHOR_URL = os.environ.get("AUTHOR_URL", "https://t.me/PolitCotext")

MAX_CONTENT_LENGTH = int(os.environ.get("TELEGRAPH_MAX_CONTENT", 34_000))
NAVIGATION_RESERVE = int(os.environ.get("TELEGRAPH_NAVIGATION_RESERVE", 1_500))
API_BASE_URL = "https://api.telegra.ph"


def get_node_size(node):
    return len(json.dumps(node, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def build_payload(title, content, path=None):
    payload = {
        "access_token": TOKEN,
        "title": title,
        "author_name": AUTHOR_NAME,
        "author_url": AUTHOR_URL,
        "content": serialize_content(content),
        "return_content": False,
    }
    if path:
        payload["path"] = path
    return payload


def get_payload_size(payload):
    return len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def get_content_size(content):
    return len(serialize_content(content).encode("utf-8"))


def get_create_payload_size(title, content):
    return get_payload_size(build_payload(title, content))


def get_edit_payload_size(title, content, path):
    return get_payload_size(build_payload(title, content, path=path))


def split_large_text(text, limit):
    if not text:
        return [""]
    if limit <= 0:
        raise ValueError("Лимит разбиения должен быть больше нуля")
    words = text.split(" ")
    parts = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip() if current else word
        if len(candidate.encode("utf-8")) <= limit:
            current = candidate
            continue
        if current:
            parts.append(current)
            current = word
        else:
            word_bytes = word.encode("utf-8")
            for idx in range(0, len(word_bytes), limit):
                chunk = word_bytes[idx : idx + limit].decode("utf-8", errors="ignore")
                if chunk:
                    parts.append(chunk)
            current = ""
    if current:
        parts.append(current)
    return parts


def split_large_node(node, limit):
    if get_node_size(node) <= limit:
        return [node]
    if isinstance(node, str):
        return split_large_text(node, limit)
    if isinstance(node, dict):
        children = node.get("children")
        if isinstance(children, str):
            chunks = split_large_text(children, limit)
            parts = []
            for chunk in chunks:
                candidate = {**node, "children": chunk}
                if get_node_size(candidate) <= limit:
                    parts.append(candidate)
                else:
                    for subchunk in split_large_text(chunk, max(1, limit // 2)):
                        adjusted = {**node, "children": subchunk}
                        if get_node_size(adjusted) > limit:
                            raise ValueError("Один из блоков превышает лимит после разбиения.")
                        parts.append(adjusted)
            return parts
        if isinstance(children, list):
            return split_nodes_with_template(children, node, limit)
    return [node]


def split_nodes_with_template(children, template, limit):
    parts = []
    current = []
    for child in children:
        for chunk in split_large_node(child, limit):
            candidate = current + [chunk]
            candidate_node = {**template, "children": candidate}
            if not current and get_node_size(candidate_node) > limit:
                raise ValueError("Один из блоков превышает лимит после разбиения.")
            if get_node_size(candidate_node) > limit and current:
                parts.append({**template, "children": current})
                current = [chunk]
            else:
                current = candidate
    if current:
        parts.append({**template, "children": current})
    return parts


def split_content_nodes(content, limit=MAX_CONTENT_LENGTH, title=None):
    if not content:
        raise ValueError("JSON контент не может быть пустым")

    parts = []
    current_nodes = []
    effective_limit = limit - NAVIGATION_RESERVE
    if effective_limit <= 0:
        raise ValueError("Лимит контента меньше или равен резерву навигации")
    payload_overhead = 0
    if title is not None:
        payload_overhead = get_create_payload_size(title, []) - get_content_size([])
    app.logger.info(
        "split_content_nodes: limit=%s effective=%s overhead=%s title=%s",
        limit,
        effective_limit,
        payload_overhead,
        title,
    )
    node_limit = max(1, effective_limit - payload_overhead)
    app.logger.info("split_content_nodes: node_limit=%s", node_limit)

    for node in content:
        for chunk in split_large_node(node, node_limit):
            if get_node_size(chunk) > node_limit:
                raise ValueError("Один из блоков превышает лимит после разбиения.")
            candidate = current_nodes + [chunk]
            size_check = (
                get_create_payload_size(title, candidate)
                if title is not None
                else get_content_size(candidate)
            )
            app.logger.debug(
                "split_content_nodes: candidate_size=%s nodes=%s",
                size_check,
                len(candidate),
            )
            if not current_nodes and size_check > effective_limit:
                raise ValueError("Один из блоков превышает лимит после разбиения.")
            if current_nodes and size_check > effective_limit:
                parts.append(current_nodes)
                current_nodes = [chunk]
            else:
                current_nodes = candidate

    if current_nodes:
        parts.append(current_nodes)

    if title is not None:
        for idx, part in enumerate(parts, start=1):
            app.logger.info(
                "split_content_nodes: part=%s payload_size=%s content_size=%s nodes=%s",
                idx,
                get_create_payload_size(title, part),
                get_content_size(part),
                len(part),
            )

    return parts


def telegraph_request(endpoint, payload):
    try:
        response = requests.post(f"{API_BASE_URL}/{endpoint}", json=payload, timeout=30)
        response.raise_for_status()
    except requests.RequestException as exc:
        raise RuntimeError(f"Ошибка соединения с Telegraph: {exc}") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("Telegraph вернул не-JSON ответ") from exc

    if not data.get("ok"):
        error_text = data.get("error")
        app.logger.error(
            "Telegraph error: %s endpoint=%s payload_size=%s",
            error_text,
            endpoint,
            get_payload_size(payload),
        )
        raise RuntimeError(f"Ошибка API Telegraph: {error_text}")
    return data["result"]


def serialize_content(content):
    return json.dumps(content, ensure_ascii=False, separators=(",", ":"))


def create_page(title, content):
    payload = build_payload(title, content)
    app.logger.info(
        "create_page: title=%s payload_size=%s content_size=%s",
        title,
        get_payload_size(payload),
        get_content_size(content),
    )
    return telegraph_request("createPage", payload)


def edit_page(path, title, content):
    payload = build_payload(title, content, path=path)
    app.logger.info(
        "edit_page: title=%s path=%s payload_size=%s content_size=%s",
        title,
        path,
        get_payload_size(payload),
        get_content_size(content),
    )
    return telegraph_request("editPage", payload)


def build_links_nodes(part_links):
    items = []
    for link in part_links:
        items.append(
            {
                "tag": "li",
                "children": [
                    {
                        "tag": "a",
                        "attrs": {"href": link["url"]},
                        "children": [link["title"]],
                    }
                ],
            }
        )
    return [
        {"tag": "p", "children": ["Ссылки на части:"]},
        {"tag": "ul", "children": items},
    ]


def build_compact_links_nodes(part_links, current_index):
    links = []
    if current_index > 0:
        prev_link = part_links[current_index - 1]
        links.extend(
            [
                "Назад: ",
                {"tag": "a", "attrs": {"href": prev_link["url"]}, "children": [prev_link["title"]]},
            ]
        )
    if current_index < len(part_links) - 1:
        next_link = part_links[current_index + 1]
        if links:
            links.append(" | ")
        links.extend(
            [
                "Вперед: ",
                {"tag": "a", "attrs": {"href": next_link["url"]}, "children": [next_link["title"]]},
            ]
        )
    if not links:
        return []
    return [{"tag": "p", "children": ["Навигация: ", *links]}]


def append_links(content, part_links, current_index, title, path):
    if len(part_links) <= 1:
        return content
    new_content = copy.deepcopy(content)
    new_content.extend(build_links_nodes(part_links))
    if get_edit_payload_size(title, new_content, path) <= MAX_CONTENT_LENGTH:
        return new_content
    compact = copy.deepcopy(content)
    compact.extend(build_compact_links_nodes(part_links, current_index))
    if get_edit_payload_size(title, compact, path) <= MAX_CONTENT_LENGTH:
        return compact
    return content


def publish_multipart(title, parts):
    published = []
    for idx, part_content in enumerate(parts, start=1):
        part_title = f"{title} (ч{idx})"
        result = create_page(part_title, part_content)
        path = result.get("path")
        url = result.get("url")
        if not path or not url:
            raise RuntimeError("Telegraph не вернул ссылку на созданную страницу")
        published.append(
            {
                "title": part_title,
                "path": path,
                "url": url,
                "content": part_content,
            }
        )

    links = [{"title": item["title"], "url": item["url"]} for item in published]
    for idx, item in enumerate(published):
        updated_content = append_links(item["content"], links, idx, item["title"], item["path"])
        edit_page(item["path"], item["title"], updated_content)

    return links


@app.route("/", methods=["GET", "POST"])
def index():
    result_urls = None
    error_msg = None

    if request.method == "POST":
        title = request.form.get("title", "").strip()
        raw_json = request.form.get("json_content", "").strip()

        if not TOKEN:
            error_msg = "Ошибка: Не задан TELEGRAPH_TOKEN в .env файле"
        elif not title or not raw_json:
            error_msg = "Заполните заголовок и JSON"
        else:
            try:
                content_data = json.loads(raw_json)
                if isinstance(content_data, dict):
                    content_data = [content_data]
                elif not isinstance(content_data, list):
                    raise ValueError("JSON контент должен быть массивом узлов или объектом")

                parts = split_content_nodes(content_data, MAX_CONTENT_LENGTH, title=title)

                if len(parts) == 1:
                    page = create_page(title, parts[0])
                    url = page.get("url")
                    if not url:
                        raise RuntimeError("Telegraph не вернул ссылку на созданную страницу")
                    result_urls = [{"title": title, "url": url}]
                else:
                    result_urls = publish_multipart(title, parts)

            except json.JSONDecodeError:
                error_msg = "Ошибка: Неверный формат JSON"
            except ValueError as exc:
                error_msg = str(exc)
            except RuntimeError as exc:
                error_msg = str(exc)
            except Exception as exc:
                app.logger.exception("Unexpected error while creating Telegraph pages")
                error_msg = f"Системная ошибка: {str(exc)}"

    return render_template(
        "index.html",
        result_urls=result_urls,
        error_msg=error_msg,
        author=AUTHOR_NAME,
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
