data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "amazon_linux_2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.ec2_architecture}"
}

data "tls_certificate" "github" {
  url = "https://token.actions.githubusercontent.com"
}

locals {
  secondary_availability_zone = element([
    for az in data.aws_availability_zones.available.names : az
    if az != var.primary_availability_zone
  ], 0)

  tags = {
    Project     = var.project_name
    Environment = "production"
    ManagedBy   = "Terraform"
    Repository  = var.github_repository
  }
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project_name}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project_name}-igw" }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.42.0.0/24"
  availability_zone       = var.primary_availability_zone
  map_public_ip_on_launch = true

  tags = { Name = "${var.project_name}-public-${var.primary_availability_zone}" }
}

resource "aws_subnet" "database_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.10.0/24"
  availability_zone = var.primary_availability_zone

  tags = { Name = "${var.project_name}-db-${var.primary_availability_zone}" }
}

resource "aws_subnet" "database_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.11.0/24"
  availability_zone = local.secondary_availability_zone

  tags = { Name = "${var.project_name}-db-${local.secondary_availability_zone}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "${var.project_name}-public" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "web" {
  name        = "${var.project_name}-web"
  description = "Public HTTP ingress; no SSH ingress"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Demo HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_http_cidrs
  }

  egress {
    description = "Required for ECR, SSM, Secrets Manager and package updates"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-web" }
}

resource "aws_security_group" "database" {
  name        = "${var.project_name}-database"
  description = "PostgreSQL only from the web security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from web instance"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.web.id]
  }

  egress {
    description = "Stateful return traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project_name}-database" }
}

resource "aws_ecr_repository" "app" {
  name                 = var.project_name
  image_tag_mutability = "IMMUTABLE"

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the 20 most recent application images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_db_subnet_group" "main" {
  name       = var.project_name
  subnet_ids = [aws_subnet.database_a.id, aws_subnet.database_b.id]
  tags       = { Name = "${var.project_name}-database" }
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${var.project_name}-postgres${var.postgres_major_version}"
  family = "postgres${var.postgres_major_version}"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "postgres" {
  identifier = var.project_name

  engine               = "postgres"
  engine_version       = var.postgres_engine_version
  instance_class       = var.db_instance_class
  parameter_group_name = aws_db_parameter_group.postgres.name

  db_name                     = "miniflow"
  username                    = "miniflow_admin"
  manage_master_user_password = true
  port                        = 5432

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period         = 7
  auto_minor_version_upgrade      = true
  copy_tags_to_snapshot           = true
  deletion_protection             = var.database_deletion_protection
  skip_final_snapshot             = !var.database_deletion_protection
  final_snapshot_identifier       = var.database_deletion_protection ? "${var.project_name}-final" : null
  apply_immediately               = true
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = { Name = var.project_name }
}
