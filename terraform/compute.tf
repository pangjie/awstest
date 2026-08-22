resource "aws_instance" "web" {
  ami                    = data.aws_ssm_parameter.amazon_linux_2023.value
  instance_type          = var.ec2_instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
  iam_instance_profile   = aws_iam_instance_profile.web.name

  associate_public_ip_address = true
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    aws_region          = var.aws_region
    ecr_registry        = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com"
    database_secret_arn = aws_db_instance.postgres.master_user_secret[0].secret_arn
    database_host       = aws_db_instance.postgres.address
    database_port       = aws_db_instance.postgres.port
    database_name       = aws_db_instance.postgres.db_name
  })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }

  tags = { Name = "${var.project_name}-web" }

  depends_on = [aws_route_table_association.public]
}
