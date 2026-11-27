# app/core/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg2://vkuser:vkpass@localhost:5432/vk_scrape"
    default_post_limit: int = 100
    request_delay_seconds: float = 0.5
    max_retries: int = 3

    vk_api_base: str = "https://web.api.vk.ru"
    vk_login_base: str = "https://login.vk.ru"
    vk_app_id: int = 6287487
    vk_app_secret: str = "QbYic1K3lEV5kTGiqlq2"
    vk_api_version: str = "5.289"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()