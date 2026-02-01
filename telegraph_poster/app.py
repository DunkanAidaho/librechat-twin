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

MAX_CONTENT_LENGTH = 34_000
API_BASE_URL = "https://api.telegra.ph"


def get_text_length(node):
    if isinstance(node, str):
        return len(node)
    if isinstance(node, list):
        return sum(get_text_length(child) for child in node)
    if isinstance(node, dict):
        length = 0
        children = node.get("children")
        if isinstance(children, list):
            length += sum(get_text_length(child) for child in children)
        elif isinstance(children, str):
            length += len(children)
        text_value = node.get("text")
        if isinstance(text_value, str):
            length += len(text_value)
        return length
    return 0


def split_content_nodes(content, limit=MAX_CONTENT_LENGTH):
    if not content:
        raise ValueError("JSON контент не может быть пустым")

    parts = []
    current_nodes = []
    current_length = 0

    for node in content:
        node_length = get_text_length(node)
        if node_length > limit:
            raise ValueError("Один из блоков превышает лимит в 34 000 символов, сократите его.")
        if current_nodes and current_length + node_length > limit:
            parts.append(current_nodes)
            current_nodes = []
            current_length = 0
        current_nodes.append(node)
        current_length += node_length

    if current_nodes:
        parts.append(current_nodes)

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
        raise RuntimeError(f"Ошибка API Telegraph: {data.get('error')}")
    return data["result"]


def serialize_content(content):
    return json.dumps(content, ensure_ascii=False)


def create_page(title, content):
    payload = {
        "access_token": TOKEN,
        "title": title,
        "author_name": AUTHOR_NAME,
        "author_url": AUTHOR_URL,
        "content": serialize_content(content),
        "return_content": False,
    }
    return telegraph_request("createPage", payload)


def edit_page(path, title, content):
    payload = {
        "access_token": TOKEN,
        "path": path,
        "title": title,
        "author_name": AUTHOR_NAME,
        "author_url": AUTHOR_URL,
        "content": serialize_content(content),
        "return_content": False,
    }
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


def append_links(content, part_links):
    if len(part_links) <= 1:
        return content
    new_content = copy.deepcopy(content)
    new_content.extend(build_links_nodes(part_links))
    return new_content


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
    for item in published:
        updated_content = append_links(item["content"], links)
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

                parts = split_content_nodes(content_data, MAX_CONTENT_LENGTH)

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
