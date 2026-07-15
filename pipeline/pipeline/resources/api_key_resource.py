from dagster import ConfigurableResource


class ApiKeyResource(ConfigurableResource):
    """Wraps a single API key so it can be provided via EnvVar.

    A bare EnvVar passed as a resource raises RuntimeError when read directly —
    it only resolves as a ConfigurableResource field.
    """

    key: str
