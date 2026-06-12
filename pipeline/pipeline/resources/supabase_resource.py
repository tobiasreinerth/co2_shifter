from dagster import ConfigurableResource
from supabase import Client, create_client


class SupabaseResource(ConfigurableResource):
    url: str
    service_role_key: str

    def get_client(self) -> Client:
        return create_client(self.url, self.service_role_key)
