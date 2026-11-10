from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    openai_api_key: SecretStr = SecretStr("")
    tavily_api_key: SecretStr = SecretStr("")
    openai_model: str = "gpt-4o-mini"
    echo_database_url: str = "sqlite+aiosqlite:///./echo.db"
    echo_demo_user: str = Field("local-demo", min_length=1, max_length=128)
    echo_turn_timeout: float = Field(35, gt=0, le=180)
    echo_model_timeout: float = Field(12, gt=0, le=120)
    echo_search_timeout: float = Field(5, gt=0, le=60)
    echo_max_search_calls: int = Field(2, ge=1, le=2)
    echo_max_search_results: int = Field(4, ge=1, le=6)
    echo_search_cache_size: int = Field(256, ge=0, le=4096)
    echo_ttl_news: int = Field(900, ge=0)
    echo_ttl_market: int = Field(3600, ge=0)
    echo_ttl_release: int = Field(21600, ge=0)
    echo_ttl_general: int = Field(86400, ge=0)
    echo_log_level: str = "INFO"
