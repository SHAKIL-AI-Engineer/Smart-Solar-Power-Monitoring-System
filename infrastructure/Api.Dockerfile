FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY services/platform-api/Platform.Api.csproj services/platform-api/
RUN dotnet restore services/platform-api
COPY services/platform-api/ services/platform-api/
RUN dotnet publish services/platform-api -c Release -o /out --no-restore
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:5080
EXPOSE 5080
ENTRYPOINT ["dotnet", "Platform.Api.dll"]
