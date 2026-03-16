#!/usr/bin/env python3
"""
Скрипт для переиндексации сообщений, которые не были обработаны.
"""
import os
import sys
import asyncio
import logging
from pymongo import MongoClient
import redis
import json

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# --- Конфигурация ---
MONGO_URI = os.getenv("MONGO_URI", "mongodb://mongoadmin:(/?MiqEK@#7ACb~HX7D}#4{rz7QhZ@10.10.23.1:27017/?authSource=admin")
REDIS_HOST = os.getenv("REDIS_HOST", "10.10.23.1")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "(/?MiqEK@#7ACb~HX7D}#4{rz7QhZ")
REDIS_QUEUE_NAME = "conversation_memory_queue"

async def main():
    logger.info("Starting reindex script...")
    
    # Подключаемся к MongoDB
    mongo_client = MongoClient(MONGO_URI)
    db = mongo_client["LibreChat"]
    messages_collection = db["messages"]
    
    # Подключаемся к Redis
    redis_client = redis.Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD, decode_responses=True)
    
    # Находим сообщения, которые не были обработаны
    failed_messages = messages_collection.find({
        "isMemoryStored": {"$ne": True},
        "$or": [
            {"text": {"$exists": True, "$ne": ""}},
            {"content.0.text": {"$exists": True, "$ne": ""}}
        ]
    })
    
    count = 0
    for msg in failed_messages:
        user_id = msg.get("user")
        conversation_id = msg.get("conversationId")
        message_id = msg.get("messageId")
        role = "assistant" if msg.get("isCreatedByUser") == False else "user"
        
        # Извлекаем текст
        text_content = msg.get("text") or (msg.get("content", [{}])[0].get("text") if msg.get("content") else None)
        
        if not text_content:
            continue
        
        created_at = msg.get("createdAt", "").replace(" ", "T") + "Z" if msg.get("createdAt") else None
        
        # Формируем задачу
        task = {
            "type": "add_turn",
            "payload": {
                "user_id": user_id,
                "conversation_id": conversation_id,
                "message_id": message_id,
                "role": role,
                "content": text_content,
                "created_at": created_at
            }
        }
        
        # Добавляем в очередь Redis
        redis_client.rpush(REDIS_QUEUE_NAME, json.dumps(task))
        count += 1
        logger.info(f"Re-queued message {message_id} ({count})")
    
    logger.info(f"Reindex complete. Re-queued {count} messages.")
    mongo_client.close()

if __name__ == "__main__":
    asyncio.run(main())
